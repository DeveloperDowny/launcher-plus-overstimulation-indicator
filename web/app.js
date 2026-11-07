"use strict";
// Port of launcher.py. State is derived from the user's own events in Supabase.
// Hardened: login works immediately (no network dependency), errors are shown on screen.
const $ = (id) => document.getElementById(id);

function diag(msg) {
  const d = $("diag");
  if (!d) return;
  d.textContent = msg;
  d.hidden = false;
}
window.addEventListener("error", (e) => diag("Script error: " + (e.message || e)));
window.addEventListener("unhandledrejection", (e) => diag("Error: " + ((e.reason && e.reason.message) || e.reason)));

const C = window.CONFIG || { SUPABASE_URL: "", SUPABASE_KEY: "", USER_IDS: [] };
if (!window.CONFIG) diag("config.js failed to load. Reload the page; if it persists, contact the study team.");

const POINTS_PER_WEIGHT = 1.5, DECAY_PER_MIN = 0.3, BREAK_RELIEF = 0.6;
const SWITCH_WINDOW_MIN = 5, SWITCH_APPS = 3, AUTO_BREAK_IDLE_MIN = 20;
const LATE_NIGHT_START = 22, LATE_NIGHT_END = 5, LATE_NIGHT_MULT = 1.5; // 10 PM-5 AM local: likely under-rested, prioritise sleep
// sessions (B1, B2)
const SESSION_GRACE_MIN = 5;        // first 5 min of a session are covered by the launch cost
const PER_MIN_PER_WEIGHT = 0.1;     // per-minute cost after grace = weight * this (* late-night mult)
const SESSION_DEFAULT_MIN = 20;     // assumed session length when the real length is unknown
const SESSION_MAX_MIN = 90;         // upper bound for "the whole time" answers
// penalties (B3, B4)
const CHECK_REPEATS = 3;            // same app this many times...
const CHECK_WINDOW_MIN = 10;        // ...within this many minutes = checking loop
// rest (B8, B9, A5)
const BREAK_FULL_MIN = 15;          // a break this long gets the full BREAK_RELIEF (0.6)
const SLEEP_GAP_MIN = 300;          // a gap of 5+ hrs before an action = sleep -> wake event
// input safety (C3, D2)
const FEEL_CONFIRM_DELTA = 30;      // confirm a check-in that moves the level by 30+ points
const DOUBLE_TAP_MS = 2000;
// nudges (E1)
const NUDGE_WINDOW_MIN = 10;
const SCORING_VERSION = "2026-11-sessions"; // on every event, so before/after this change can be told apart
const BANDS = [[25, "calm", "Plenty of room. Go ahead."], [50, "steady", "Fine, but you're warming up."],
  [75, "loaded", "Getting heavy. A break would help."], [100, "frayed", "Overstimulated. Stop adding input; take a break."]];
const MIN = 60000;
let DOOM = { activities: ["short_videos", "social_profiles", "news"], streak: 3 }; // overridden by inventory.json

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};
const now = () => Date.now() + (+store.get("debugSkewMs") || 0); // testers can time-travel via localStorage.debugSkewMs
const localDate = (d = new Date(now())) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const lateNight = (d = new Date(now())) => d.getHours() >= LATE_NIGHT_START || d.getHours() < LATE_NIGHT_END;
const bandOf = (l) => BANDS.find((b) => l <= b[0]);
const clamp = (l) => Math.max(0, Math.min(100, l));
const round1 = (x) => Math.round(x * 10) / 10, round2 = (x) => Math.round(x * 100) / 100;
const iso = (ms) => new Date(ms).toISOString();
const newId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));
const DEVICE_ID = store.get("deviceId") || (() => { const id = newId(); store.set("deviceId", id); return id; })();

// S is the scoring state; it is broadcast to other tabs and rebuilt from events (deriveState).
// Purely local UI state (pending session question, double-tap guard, roulette button) lives outside it.
let INV = null, userId = null, S = null;
let pendingSession = null; // {snap, gap}: a session closed after a long gap, waiting for "how long were you on X?"
let lastTap = null, feelTouched = false, pendingFeel = null, lastFeel = null, leftAt = null;
let rouletteText = null, showRoulette = false, morningAns = {};

function freshState(t) {
  return {
    level: 0, updatedAt: t, startedAt: t, lastEventAt: null, lastBreakAt: null,
    opens: [],                         // [[ms, app]] stimulating launches since the last rest, last CHECK_WINDOW_MIN
    lastSwitchPenaltyAt: null, lastCheckPenaltyAt: {}, doomStreak: 0, lastOpenDay: null,
    session: null,                     // {app, activity, weight, mult, startedAt, levelAtStart, device}
    breakStartedAt: null, levelAtBreakStart: null, restStartAt: null,
    wakeDay: null, lastWakeDay: null, lastSleepLogAt: null,
    nudge: null,                       // {id, reason, at}
  };
}

// ---------- supabase (plain REST, no SDK) ----------
function headers(extra = {}) {
  const h = { apikey: C.SUPABASE_KEY, "Content-Type": "application/json", ...extra };
  if (C.SUPABASE_KEY.startsWith("eyJ")) h.Authorization = "Bearer " + C.SUPABASE_KEY;
  return h;
}
async function sbGet(path) {
  const r = await fetch(`${C.SUPABASE_URL}/rest/v1/${path}`, { headers: headers() });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function sbPost(table, row) {
  const queue = JSON.parse(store.get("pending") || "[]");
  queue.push({ table, row });
  store.set("pending", JSON.stringify(queue));
  flush();
}
let flushing = false;
async function flush() { // simple offline-tolerant queue
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const q = JSON.parse(store.get("pending") || "[]"); // re-read: new events may be appended while we await
      if (!q.length) break;
      const { table, row } = q[0];
      const r = await fetch(`${C.SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST", headers: headers({ Prefer: "return=minimal" }), body: JSON.stringify(row) });
      if (!r.ok && r.status >= 500) break; // retry later
      if (!r.ok) diag(`The server rejected a ${row.event || table} record (HTTP ${r.status}); it was dropped.`);
      const cur = JSON.parse(store.get("pending") || "[]");
      cur.shift(); // success, or a permanent client error we can't fix by retrying
      store.set("pending", JSON.stringify(cur));
    }
  } catch { /* offline: keep queue */ }
  flushing = false;
}

// ---------- inventory (loaded lazily; login never depends on it) ----------
async function loadInventory() {
  if (INV) return INV;
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch("inventory.json", { cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const text = await r.text();
      INV = JSON.parse(text);
      if (INV.doomscroll) DOOM = INV.doomscroll;
      store.set("inv", text);
      return INV;
    } catch (e) { lastErr = e; }
  }
  const cached = store.get("inv"); // fall back to the last good copy
  if (cached) { try { INV = JSON.parse(cached); if (INV.doomscroll) DOOM = INV.doomscroll; diag("Couldn't refresh the app list; using a saved copy."); return INV; } catch {} }
  throw new Error("Couldn't load the app list (inventory.json): " + ((lastErr && lastErr.message) || lastErr));
}
const nightMultFor = (actId) => (INV && INV.nightMult && INV.nightMult[actId]) || LATE_NIGHT_MULT;

// ---------- level ----------
// B9: one rest formula for breaks, auto-breaks and wake: the larger of plain decay or scaled relief, never both
function restRelief(levelBefore, minutes) {
  const decay = DECAY_PER_MIN * minutes;
  const scaled = levelBefore * BREAK_RELIEF * Math.min(1, minutes / BREAK_FULL_MIN);
  return Math.min(levelBefore, Math.max(decay, scaled));
}
function decayed(t = now()) {
  if (S.breakStartedAt != null) return S.levelAtBreakStart - restRelief(S.levelAtBreakStart, (t - S.breakStartedAt) / MIN); // projected
  if (S.session && S.session.weight > 0) return S.level; // B1: no decay while still in a stimulating app
  return Math.max(0, S.level - DECAY_PER_MIN * Math.max(0, t - S.updatedAt) / MIN);
}
function settle(t = now()) { S.level = decayed(t); S.updatedAt = t; return S.level; }
function minsSinceBreak() { return Math.floor((now() - (S.lastBreakAt ?? S.startedAt)) / MIN); }
const currentWakeDay = () => S.wakeDay || localDate(new Date(now() - 4 * 60 * MIN)); // before any wake: 4 AM cutoff
function resetWindows() { S.opens = []; S.lastSwitchPenaltyAt = null; S.lastCheckPenaltyAt = {}; S.doomStreak = 0; }

// ---------- rebuild state from the newest events (pure; try it in the console) ----------
function deriveState(events, nowMs, firstTs = null) {
  const st = freshState(nowMs);
  if (!events || !events.length) return st;
  const ev = events.map((e) => ({ ...e, t: Date.parse(e.ts) })); // newest first
  const e0 = ev[0];
  st.startedAt = firstTs ?? ev[ev.length - 1].t;
  st.lastEventAt = e0.t;
  st.level = e0.level_after ?? 0; st.updatedAt = e0.t; st.restStartAt = e0.t;
  if (e0.event === "session_end") { // rest starts when the session ended, not when it was logged
    const o = ev.slice(1).find((x) => x.event === "open" && x.app === e0.app);
    if (o) st.updatedAt = st.restStartAt = o.t + (+e0.session_minutes || 0) * MIN;
  }
  // a rest resets the switching/checking windows and the doomscroll streak (pre-change "break" rows were instant rests)
  const isRest = (e) => ["break_end", "auto_break", "wake"].includes(e.event) || (e.event === "break" && !e.scoring_version);
  for (const e of ev) { // open session: newest launch with a url and a weight, not closed by anything later
    if (["session_end", "break", "break_end", "auto_break", "wake", "feel"].includes(e.event)) break;
    if (e.event !== "open") continue;
    if (e.url && e.weight && nowMs - e.t < SESSION_MAX_MIN * MIN) {
      st.session = { app: e.app, activity: e.activity, weight: e.weight, levelAtStart: e.level_after, startedAt: e.t,
        mult: e.weight > 0 && lateNight(new Date(e.t)) ? nightMultFor(e.activity) : 1,
        device: +store.get("sessionStart_" + e.user_id) === e.t ? DEVICE_ID : null };
    }
    break;
  }
  for (const e of ev) { // open break: newest break with no later break_end
    if (isRest(e)) break;
    if (e.event === "break") { st.breakStartedAt = e.t; st.levelAtBreakStart = e.level_after; break; }
  }
  st.wakeDay = e0.wake_day || null;
  st.lastWakeDay = (ev.find((e) => e.event === "wake") || {}).wake_day || null;
  const restIdx = ev.findIndex(isRest);
  const sinceRest = restIdx < 0 ? ev : ev.slice(0, restIdx);
  const opens = sinceRest.filter((e) => e.event === "open" && e.weight > 0 && nowMs - e.t < CHECK_WINDOW_MIN * MIN);
  st.opens = opens.map((e) => [e.t, e.app]).reverse();
  const sw = opens.find((e) => +e.switch_penalty > 0 && nowMs - e.t < SWITCH_WINDOW_MIN * MIN);
  st.lastSwitchPenaltyAt = sw ? sw.t : null;
  for (const e of opens) if (+e.check_penalty > 0 && st.lastCheckPenaltyAt[e.app] == null) st.lastCheckPenaltyAt[e.app] = e.t;
  for (const e of ev) { // back-to-back doomscroll launches, stopping at any other launch or a rest
    if (e.event === "open") { if (DOOM.activities.includes(e.activity)) st.doomStreak++; else break; }
    else if (isRest(e)) break;
  }
  const lastOpen = ev.find((e) => e.event === "open" && e.activity !== "going_to_sleep");
  st.lastOpenDay = lastOpen ? localDate(new Date(lastOpen.t)) : null;
  const sleepLog = ev.find((e) => e.event === "open" && e.activity === "going_to_sleep");
  st.lastSleepLogAt = sleepLog ? sleepLog.t : null;
  const rest = ev.find(isRest);
  st.lastBreakAt = rest ? (rest.break_at ? Date.parse(rest.break_at) : rest.t) : null;
  const n = ev.find((e) => e.event === "nudge");
  if (n && !ev.some((e) => e.event === "nudge_outcome" && e.nudge_id === n.nudge_id)) st.nudge = { id: n.nudge_id, reason: n.nudge_reason, at: n.t };
  return st;
}
async function fetchState() {
  const q = `events?user_id=eq.${encodeURIComponent(userId)}`;
  const [events, first] = await Promise.all([
    sbGet(`${q}&order=ts.desc,id.desc&limit=100&select=*`),
    sbGet(`${q}&order=ts.asc,id.asc&limit=1&select=ts`),
  ]);
  return deriveState(events, now(), first[0] ? Date.parse(first[0].ts) : null);
}

// ---------- logging (same fields as the CLI's log.txt, plus user_id) ----------
let broadcastQueued = false;
function log(event, before, after, extra = {}) {
  const d = new Date(now());
  S.lastEventAt = d.getTime();
  sbPost("events", {
    user_id: userId, ts: d.toISOString(),
    date: localDate(d), // tester's local date/hour
    hour: d.getHours(), weekday: d.toLocaleDateString("en-US", { weekday: "short" }),
    event, level_before: Math.round(before), band_before: bandOf(before)[1],
    level_after: Math.round(after), band_after: bandOf(after)[1],
    mins_since_break: minsSinceBreak(),
    last_break_at: S.lastBreakAt ? iso(S.lastBreakAt) : null,
    break_taken_yet: S.lastBreakAt != null, wake_day: currentWakeDay(), scoring_version: SCORING_VERSION, ...extra,
  });
  if (!broadcastQueued) { broadcastQueued = true; queueMicrotask(() => { broadcastQueued = false; broadcast(); }); }
}

// ---------- D4: other tabs on this device ----------
let channel = null;
function openChannel() {
  if (!("BroadcastChannel" in window)) return;
  if (channel) channel.close();
  channel = new BroadcastChannel("osl-" + userId);
  channel.onmessage = (e) => { if (e.data && e.data.S) { S = e.data.S; render(); } };
}
function broadcast() { try { if (channel && S) channel.postMessage({ S }); } catch {} }

// other devices: adopt the server's state when it has something newer than anything this tab logged
let refreshing = false;
async function refreshFromServer() {
  if (refreshing || !userId || !S) return;
  refreshing = true;
  try {
    const st = await fetchState();
    const queued = JSON.parse(store.get("pending") || "[]")
      .filter((q) => q.table === "events" && q.row.user_id === userId).map((q) => Date.parse(q.row.ts));
    const localNewest = Math.max(S.lastEventAt || 0, ...queued);
    if (st.lastEventAt && st.lastEventAt > localNewest) { S = st; pendingSession = null; render(); }
  } catch { /* offline: keep local state */ }
  refreshing = false;
}

// ---------- sessions (B1, B2) ----------
function applySession(snap, minutes) {
  const cost = Math.max(0, minutes - SESSION_GRACE_MIN) * snap.weight * PER_MIN_PER_WEIGHT * snap.mult;
  const level = clamp(snap.weight > 0 ? snap.levelAtStart + cost : snap.levelAtStart - DECAY_PER_MIN * minutes + cost);
  const end = snap.startedAt + minutes * MIN;
  S.level = level; S.updatedAt = end; S.restStartAt = end; // decay and rest start when the session ended
  return { cost, level };
}
function logSessionEnd(snap, minutes, endedBy) {
  const { cost, level } = applySession(snap, minutes);
  log("session_end", snap.levelAtStart, level, { command: "(session end)", app: snap.app, activity: snap.activity,
    activity_label: INV && INV.activities[snap.activity] ? INV.activities[snap.activity].label : null, weight: snap.weight,
    points_added: round1(cost), session_minutes: round1(minutes), ended_by: endedBy });
}
function closeSession(t, reason) { // reason: return | next_action
  const snap = S.session;
  if (!snap) return;
  S.session = null;
  const gap = (t - snap.startedAt) / MIN;
  if (gap <= SESSION_DEFAULT_MIN) return logSessionEnd(snap, gap, reason);
  if (reason === "return") { pendingSession = { snap, gap }; applySession(snap, SESSION_DEFAULT_MIN); return; } // ask; 20 min until answered
  logSessionEnd(snap, SESSION_DEFAULT_MIN, "default");
}
function resolvePending(minutes, endedBy) {
  const p = pendingSession;
  if (!p) return;
  pendingSession = null;
  logSessionEnd(p.snap, minutes, endedBy);
}
function answerSession(choice) {
  if (!pendingSession) return;
  const gap = pendingSession.gap;
  resolvePending(choice === "all" ? Math.min(gap, SESSION_MAX_MIN) : Math.min(+choice, gap), "answered");
  render();
}

// ---------- rest: auto-break and wake (B9, A5) ----------
function sleepSource(sleepStart) {
  const s = S.lastSleepLogAt;
  return s != null && s <= sleepStart && sleepStart - s <= 60 * MIN ? "logged" : "inferred";
}
function restCheck(t, lastEventBefore) {
  if (S.session || pendingSession || S.breakStartedAt != null || S.restStartAt == null) return;
  const gap = (t - S.restStartAt) / MIN;
  if (gap <= AUTO_BREAK_IDLE_MIN) return;
  const before = Math.max(0, S.level - DECAY_PER_MIN * Math.max(0, S.restStartAt - S.updatedAt) / MIN); // level at rest start
  const relief = restRelief(before, gap), after = before - relief;
  const breakAt = S.restStartAt + AUTO_BREAK_IDLE_MIN * MIN;
  S.level = after; S.updatedAt = t;
  if (gap >= SLEEP_GAP_MIN) {
    const sleepStart = lastEventBefore ?? S.restStartAt;
    S.wakeDay = S.lastWakeDay = localDate(new Date(t));
    S.lastBreakAt = t;
    log("wake", before, after, { command: "(wake)", break_minutes: round2(gap), relief: round1(relief),
      sleep_start: iso(sleepStart), sleep_minutes: Math.round(gap), sleep_source: sleepSource(sleepStart) });
    toast(`Good morning. ${Math.round(before)}% → ${Math.round(after)}%`);
  } else {
    S.lastBreakAt = breakAt;
    log("auto_break", before, after, { command: "(idle gap)", idle_minutes: Math.round(gap), inferred: true,
      break_at: iso(breakAt), break_minutes: round2(gap), relief: round1(relief) });
    toast(`Auto-break: ${Math.round(gap)} min idle. ${Math.round(before)}% → ${Math.round(after)}%`);
  }
  resetWindows();
}

// ---------- breaks (B8) ----------
function startBreak(t) {
  const level = settle(t);
  log("break", level, level, { command: "take break", break_at: iso(t) });
  S.breakStartedAt = t; S.levelAtBreakStart = level;
  toast(`Break started. The longer it lasts, the more it helps (full effect at ${BREAK_FULL_MIN} min).`);
}
function endBreak(t) {
  const start = S.breakStartedAt, before = S.levelAtBreakStart;
  if (start == null) return;
  const minutes = (t - start) / MIN, relief = restRelief(before, minutes), after = before - relief;
  S.breakStartedAt = null; S.levelAtBreakStart = null;
  S.level = after; S.updatedAt = t; S.restStartAt = t; S.lastBreakAt = t;
  resetWindows();
  log("break_end", before, after, { command: "end break", break_minutes: round2(minutes), relief: round1(relief) });
  if (minutes >= SLEEP_GAP_MIN) { // slept through an open break: the break already brought the level down
    S.wakeDay = S.lastWakeDay = localDate(new Date(t));
    log("wake", after, after, { command: "(wake)", break_minutes: round2(minutes), relief: 0,
      sleep_start: iso(start), sleep_minutes: Math.round(minutes), sleep_source: sleepSource(start) });
  }
}

// ---------- nudges (E1) ----------
function newNudge(reason) {
  const t = now();
  if (S.nudge) logNudgeOutcome("superseded", t);
  S.nudge = { id: newId(), reason, at: t };
  const l = decayed(t);
  log("nudge", l, l, { command: "(nudge)", nudge_id: S.nudge.id, nudge_reason: reason });
}
function logNudgeOutcome(outcome, t) {
  const n = S.nudge, l = decayed(t);
  S.nudge = null;
  log("nudge_outcome", l, l, { command: "(nudge outcome)", nudge_id: n.id, nudge_reason: n.reason, nudge_outcome: outcome,
    response_min: outcome === "none" ? null : round1((t - n.at) / MIN) });
}
function resolveNudge(kind, d, t) { // logged before the deciding action's own event: nudge -> outcome -> action
  if (!S.nudge) return;
  if ((t - S.nudge.at) / MIN > NUDGE_WINDOW_MIN) return logNudgeOutcome("none", t);
  let outcome = null;
  if (kind === "break") outcome = "break";
  else if (kind === "roulette_btn") outcome = "roulette";
  else if (kind === "launch") outcome = d.app === "roulette" ? "roulette" : d.weight < 0 ? "calming" : d.weight > 0 ? "ignored" : null;
  if (outcome) logNudgeOutcome(outcome, t); // check-ins, context and other weight-0 launches keep waiting
}

// ---------- the action pipeline (5.0): every tap goes through here, in this order ----------
function tapOk(key) { // D2: ignore an identical tap within DOUBLE_TAP_MS
  const t = Date.now();
  if (lastTap && lastTap.key === key && t - lastTap.at < DOUBLE_TAP_MS) return false;
  lastTap = { key, at: t };
  return true;
}
function beginAction(kind, d = {}) { // kind: launch | break | feel | context | morning | roulette_btn
  const t = now(), lastEventBefore = S.lastEventAt;
  if (kind !== "context") { // context chips don't close a session or end a break
    if (pendingSession) resolvePending(SESSION_DEFAULT_MIN, "default");
    closeSession(t, "next_action");
    if (kind !== "break") endBreak(t);
  }
  restCheck(t, lastEventBefore);
  resolveNudge(kind, d, t);
  return t;
}
function finishAction(t) {
  if (!S.session) S.restStartAt = t;
  render();
}

// crossing into the frayed band: copy the calming list and open the roulette site.
// Runs inside the tap, so the clipboard write is allowed; a second popup may still be
// blocked, which is why the level card also shows a roulette button after a nudge.
// The first launch of the day copies the morning list instead.
function openRoulette(text, why = "Lots of overstimulation", siteOpen = false) {
  if (!INV || !INV.roulette) return;
  text = text || INV.roulette.clipboard;
  rouletteText = text; showRoulette = true; // keep the button around in case the extra tab is blocked
  try { navigator.clipboard.writeText(text).then(() => toast(`${why}: list copied, opening the roulette.`),
    () => toast(`${why}: opening the roulette (couldn't copy the list).`)); } catch {}
  if (!siteOpen) window.open(INV.roulette.url, "_blank", "noopener");
  render();
}
function maybeRoulette(before, after, doomscrolling = false, firstOfDay = false, siteOpen = false) {
  const frayed = bandOf(before)[1] !== "frayed" && bandOf(after)[1] === "frayed";
  if (frayed || doomscrolling) {
    openRoulette(null, frayed ? "Lots of overstimulation" : `${DOOM.streak} doomscroll launches in a row`, siteOpen);
    newNudge(frayed ? "frayed_roulette" : "doomscroll_roulette");
    return true;
  }
  if (firstOfDay) {
    openRoulette(INV.roulette && INV.roulette.morning, "First launch of the day", siteOpen);
    newNudge("morning_roulette");
    return true;
  }
  return false;
}
function tapRoulette() {
  if (!tapOk("roulette_btn")) return;
  openRoulette(rouletteText, "Roulette");
  finishAction(beginAction("roulette_btn"));
}

// ---------- actions ----------
function openApp(appKey, actId) {
  if (!tapOk(`launch:${appKey}|${actId}`)) return;
  const a = INV.apps[appKey], act = INV.activities[actId];
  const url = INV.urlOverrides[`${appKey}|${actId}`] || a.url;
  if (url) window.open(url, "_blank", "noopener"); // must happen synchronously inside the tap; dummy launches have no url
  const t = beginAction("launch", { app: appKey, weight: act.weight });
  const before = settle(t);
  S.opens = S.opens.filter((r) => r[0] >= t - CHECK_WINDOW_MIN * MIN);
  if (act.weight > 0) S.opens.push([t, appKey]); // calming launches count as neither switching nor checking
  let sw = 0, ck = 0, repeat = null;
  if (act.weight > 0) {
    // B3: 3+ distinct apps in 5 min, penalised at most once per window
    const distinct = new Set(S.opens.filter((r) => r[0] >= t - SWITCH_WINDOW_MIN * MIN).map((r) => r[1])).size;
    if (distinct >= SWITCH_APPS && (S.lastSwitchPenaltyAt == null || t - S.lastSwitchPenaltyAt >= SWITCH_WINDOW_MIN * MIN)) {
      sw = INV.activities.app_switching.weight * POINTS_PER_WEIGHT;
      S.lastSwitchPenaltyAt = t;
    }
    // B4: the same app 3+ times in 10 min is a checking loop, penalised at most once per window per app
    repeat = S.opens.filter((r) => r[1] === appKey).length;
    const lastCheck = S.lastCheckPenaltyAt[appKey];
    if (repeat >= CHECK_REPEATS && (lastCheck == null || t - lastCheck >= CHECK_WINDOW_MIN * MIN)) {
      ck = (INV.activities.checking_loop ? INV.activities.checking_loop.weight : 6) * POINTS_PER_WEIGHT;
      S.lastCheckPenaltyAt[appKey] = t;
    }
  }
  const mult = act.weight > 0 && lateNight(new Date(t)) ? nightMultFor(actId) : 1; // calming/neutral launches are never boosted
  const points = (act.weight * POINTS_PER_WEIGHT + sw + ck) * mult;
  S.level = clamp(before + points);
  S.doomStreak = DOOM.activities.includes(actId) ? (S.doomStreak || 0) + 1 : 0; // any other launch restarts the count
  const day = localDate(new Date(t)), prevDay = [S.lastOpenDay, store.get("lastOpen_" + userId)].filter(Boolean).sort().pop();
  const firstOfDay = actId !== "going_to_sleep" && prevDay !== day; // a bedtime log doesn't use up the day's first launch
  if (actId !== "going_to_sleep") { S.lastOpenDay = day; store.set("lastOpen_" + userId, day); }
  else S.lastSleepLogAt = t;
  const doomscrolling = S.doomStreak > 0 && S.doomStreak % DOOM.streak === 0;
  log("open", before, S.level, { command: `${appKey} ${actId}`, app: appKey, activity: actId, activity_label: act.label,
    weight: act.weight, points_added: round1(points), switch_penalty: round1(sw), check_penalty: round1(ck * mult),
    repeat_count: repeat, url });
  toast(`${appKey}: ${points > 0 ? "+" : ""}${Math.round(points)}%${sw ? " (app-switching penalty)" : ""}${ck ? " (checking loop)" : ""}${mult > 1 ? " (late night x" + mult + ": prioritise sleep)" : ""}`);
  if (url && act.weight !== 0) { // the time spent in the app is costed when you come back (sessions)
    S.session = { app: appKey, activity: actId, weight: act.weight, mult, startedAt: t, levelAtStart: S.level, device: DEVICE_ID };
    store.set("sessionStart_" + userId, String(t));
  }
  finishAction(t);
  const nudged = maybeRoulette(before, S.level, doomscrolling, firstOfDay, appKey === "roulette");
  if (!nudged && before <= 50 && S.level > 50) newNudge("loaded_band");
}

function takeBreak() {
  if (!tapOk("break")) return;
  const t0 = now();
  if (S.breakStartedAt != null) {
    const before = S.levelAtBreakStart;
    endBreak(t0);
    resolveNudge("break_end", {}, t0); // ending a break only expires an old nudge
    toast(`Break ended: ${Math.round(before)}% → ${Math.round(S.level)}%`);
    return finishAction(t0);
  }
  const t = beginAction("break");
  startBreak(t);
  finishAction(t);
}

// C3: the button only works after the slider moved; big jumps need a confirm
function submitFeel() {
  if (!feelTouched) return;
  const v = +$("feel").value, cur = decayed();
  if (Math.abs(v - cur) >= FEEL_CONFIRM_DELTA) {
    pendingFeel = v;
    $("feelConfirmQ").innerHTML = `The app thinks you're at <strong>${Math.round(cur)}%</strong>. Set it to <strong>${v}%</strong>?`;
    $("feelYes").textContent = `Yes, set ${v}%`;
    $("feelConfirm").hidden = false;
    return;
  }
  setFeel(v, false);
}
function setFeel(v, confirmed) {
  if (!tapOk("feel")) return;
  $("feelConfirm").hidden = true; pendingFeel = null;
  const t = beginAction("feel");
  const before = settle(t);
  S.level = v;
  log("feel", before, v, { command: "feel", felt: v, computed_level: Math.round(before), feel_confirmed: confirmed });
  lastFeel = { felt: v, computed: Math.round(before) };
  $("accQ").textContent = `The app estimated ${lastFeel.computed}% and you said ${v}%. Was the estimate:`;
  $("accBox").hidden = false;
  feelTouched = false;
  finishAction(t);
  maybeRoulette(before, v);
}
function sendAccuracy(ok) {
  sbPost("feedback", { user_id: userId, kind: "accuracy", accurate: ok, felt: lastFeel.felt, computed_level: lastFeel.computed });
  $("accBox").hidden = true; toast("Thanks!");
}
function sendText() {
  const m = $("fbText").value.trim();
  if (!m) return;
  sbPost("feedback", { user_id: userId, kind: "text", message: m });
  $("fbText").value = ""; toast("Feedback sent. Thank you!");
}

// A6: context never changes the level; it's for analysis
function logContext(tag, value, t) {
  const l = decayed(t);
  log("context", l, l, { command: "context", tag, tag_value: value });
}
function tapContext(tag, value) {
  if (!tapOk(`context:${tag}:${value}`)) return;
  const t = beginAction("context");
  logContext(tag, value, t);
  toast("Noted");
  finishAction(t);
}
function answerMorning(tag, value) {
  if (!tapOk(`context:${tag}:${value}`)) return;
  const t = beginAction("morning"); // counts as an action, so it logs the wake if one is due
  logContext(tag, value, t);
  morningAns[tag] = value;
  if (morningAns.sleep_quality && morningAns.day_load) store.set("morningDone_" + userId, currentWakeDay());
  finishAction(t);
}
function skipMorning() { store.set("morningDone_" + userId, currentWakeDay()); render(); }
function morningDue(t) {
  const doneDay = store.get("morningDone_" + userId);
  const resting = S.restStartAt != null && !S.session && !pendingSession && S.breakStartedAt == null;
  const byGap = resting && (t - S.restStartAt) / MIN >= SLEEP_GAP_MIN && doneDay !== localDate(new Date(t));
  const byWake = S.lastWakeDay != null && S.lastWakeDay === S.wakeDay && doneDay !== S.wakeDay;
  return byGap || byWake;
}

// ---------- render ----------
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = "none"), 3500);
}
function render() {
  if (!S) return;
  const t = now(), l = decayed(t), [, name, comment] = bandOf(l);
  const color = `var(--${name})`;
  $("pct").textContent = Math.round(l);
  $("band").textContent = name.toUpperCase(); $("band").style.color = color;
  $("fill").style.width = l + "%"; $("fill").style.background = color;
  $("comment").textContent = comment;
  $("rouletteBtn").hidden = !(name === "frayed" || showRoulette);
  const onBreak = S.breakStartedAt != null, breakMin = onBreak ? Math.floor((t - S.breakStartedAt) / MIN) : 0;
  $("since").textContent = onBreak ? `On a break · ${breakMin} min`
    : S.session ? `In ${S.session.app} · ${Math.floor((t - S.session.startedAt) / MIN)} min`
    : S.lastBreakAt ? `${minsSinceBreak()} min since last break` : `No break yet (${minsSinceBreak()} min since you started)`;
  $("breakBtn").textContent = onBreak ? `End break · ${breakMin} min (full effect at ${BREAK_FULL_MIN} min)` : "Take a break";
  $("sessQ").hidden = !pendingSession;
  if (pendingSession) $("sessQText").textContent = `How long were you on ${pendingSession.snap.app}?`;
  $("morning").hidden = !morningDue(t);
  document.querySelectorAll("[data-morning]").forEach((b) => {
    const [tag, value] = b.dataset.morning.split(":");
    b.className = morningAns[tag] === value ? "" : "ghost";
  });
  $("feelBtn").disabled = !feelTouched; $("feelHint").hidden = feelTouched;
}
function renderApps() {
  const box = $("apps");
  if (!INV) { box.textContent = ""; return; }
  const f = $("search").value.trim().toLowerCase();
  box.innerHTML = "";
  for (const [key, a] of Object.entries(INV.apps)) {
    if (f && !(key + " " + a.aliases.join(" ")).toLowerCase().includes(f)) continue;
    const card = document.createElement("div"); card.className = "card";
    const def = INV.activities[a.default];
    card.innerHTML = `<div class="flex"><div><strong>${key}</strong><div class="muted">${def.label} · weight ${def.weight}</div></div></div>`;
    const chips = document.createElement("div"); chips.className = "chips";
    for (const actId of a.supports) {
      if (actId === "app_switching" && a.default !== "app_switching") continue; // auto-detected, not a mode
      const act = INV.activities[actId];
      const b = document.createElement("button");
      b.className = actId === a.default ? "" : "ghost";
      b.textContent = actId === a.default ? `${a.url ? "Open" : "Log"} ${key}` : `${act.modes[0] || act.label} (${act.weight})`;
      b.onclick = () => openApp(key, actId);
      chips.appendChild(b);
    }
    card.appendChild(chips); box.appendChild(card);
  }
}

// coming back to the launcher closes the session started on this device (5.1), then checks other devices (D4)
function onVisible() {
  if (!S) return;
  const t = now();
  if (S.session && S.session.device === DEVICE_ID && leftAt != null && leftAt >= S.session.startedAt) closeSession(t, "return");
  resolveNudge("visible", {}, t); // an expired nudge is logged as "none"
  render();
  refreshFromServer();
}

// ---------- login ----------
async function start(id) {
  userId = id; store.set("uid", id);
  $("login").hidden = true; $("appview").hidden = false; $("who").textContent = id;
  S = null; pendingSession = null; morningAns = {};
  openChannel();
  // inventory and state load in parallel; either failing is reported, not fatal to the page
  const invP = loadInventory().then(renderApps).catch((e) => diag(e.message));
  const stateP = fetchState().catch(() => null);
  await invP;
  S = await stateP;
  if (!S) { toast("Can't reach server; starting fresh."); S = freshState(now()); }
  render(); flush();
}

function normId(s) { // tolerate full-width chars, zero-width chars, stray spaces, caps
  return String(s || "").normalize("NFKC").replace(new RegExp("[" + String.fromCharCode(0x200b) + "-" + String.fromCharCode(0x200d) + String.fromCharCode(0xfeff) + "\\s]", "g"), "").toLowerCase();
}
function go() {
  const err = $("loginErr");
  const id = normId($("uid").value);
  if (!id) { err.textContent = "Type your tester ID (for example tester01)."; return; }
  if (!C.USER_IDS.includes(id)) { err.textContent = `Unknown ID "${id}". Use tester01 to tester10.`; return; }
  err.textContent = "";
  start(id).catch((e) => diag("Couldn't start: " + e.message));
}

// ---------- wire up everything synchronously; nothing here waits on the network ----------
function wire() {
  $("loginForm").addEventListener("submit", (e) => { e.preventDefault(); go(); });
  $("uid").addEventListener("input", () => { $("loginErr").textContent = ""; });
  $("search").oninput = renderApps;
  $("feel").oninput = () => {
    $("feelVal").textContent = $("feel").value;
    feelTouched = true; $("feelConfirm").hidden = true; pendingFeel = null;
    if (S) render();
  };
  $("feelBtn").onclick = submitFeel;
  $("feelYes").onclick = () => pendingFeel != null && setFeel(pendingFeel, true);
  $("feelNo").onclick = () => { $("feelConfirm").hidden = true; pendingFeel = null; };
  $("rouletteBtn").onclick = tapRoulette;
  $("breakBtn").onclick = takeBreak; $("fbBtn").onclick = sendText;
  document.querySelectorAll("[data-acc]").forEach((b) => (b.onclick = () => sendAccuracy(b.dataset.acc === "1")));
  document.querySelectorAll("[data-sess]").forEach((b) => (b.onclick = () => answerSession(b.dataset.sess)));
  $("sessDismiss").onclick = () => { resolvePending(SESSION_DEFAULT_MIN, "default"); render(); };
  document.querySelectorAll("[data-morning]").forEach((b) => (b.onclick = () => answerMorning(...b.dataset.morning.split(":"))));
  $("morningSkip").onclick = skipMorning;
  document.querySelectorAll("[data-ctx]").forEach((b) => (b.onclick = () => tapContext(b.dataset.ctx, "yes")));
  $("logout").onclick = () => { store.del("uid"); location.reload(); };
  setInterval(() => { try { render(); } catch {} }, 30000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) leftAt = now(); else onVisible(); });

  const saved = store.get("uid");
  if (saved && C.USER_IDS.includes(saved)) start(saved).catch((e) => diag("Couldn't start: " + e.message));
  else { try { $("uid").focus(); } catch {} }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
