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

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};
// testing only: localStorage.debugFlags = '{"idleCap":null,"glance":false,"floor":true}' overrides the switches below
const FLAGS = (() => { try { return JSON.parse(store.get("debugFlags") || "{}"); } catch { return {}; } })();
const flag = (k, dflt) => (k in FLAGS ? (FLAGS[k] === null ? Infinity : FLAGS[k]) : dflt);

const POINTS_PER_WEIGHT = 1.5, DECAY_PER_MIN = 0.3, BREAK_RELIEF = 0.6;
const SWITCH_WINDOW_MIN = 5, SWITCH_APPS = 3, AUTO_BREAK_IDLE_MIN = 20;
const LATE_NIGHT_START = 22, LATE_NIGHT_END = 5, LATE_NIGHT_MULT = 1.5; // 10 PM-5 AM local: likely under-rested, prioritise sleep
// sessions (B1, B2)
const SESSION_GRACE_MIN = 5;        // first 5 min of a session are covered by the launch cost
const PER_MIN_PER_WEIGHT = 0.1;     // per-minute cost after grace = weight * this (* late-night mult)
const SESSION_DEFAULT_MIN = 20;     // assumed session length when the real length is unknown
const SESSION_MAX_MIN = 90;         // upper bound for "the whole time" answers
// every launch except "going to sleep" (that's rest, the wake event covers it) opens a session, so its time is recorded
// penalties (B3, B4)
const CHECK_REPEATS = 3;            // same app this many times...
const CHECK_WINDOW_MIN = 10;        // ...within this many minutes = checking loop
// rest (B8, B9, A5)
const BREAK_FULL_MIN = 15;          // a break this long gets the full BREAK_RELIEF (0.6)
const SLEEP_GAP_MIN = 300;          // a gap of 5+ hrs before an action = sleep -> wake event
// rest cap (F1): phone use outside the launcher is invisible, so only the first 30 min of a rest count
const REST_CAP_MIN = 30;            // manual breaks: minutes that count toward relief
const IDLE_REST_CAP_MIN = flag("idleCap", 30); // idle auto-breaks (gap 20 to 299 min). Infinity keeps the old behaviour
// SLEEP_GAP_MIN: gaps at or above it are sleep and are never capped
// glance discount (F3-A)
const GLANCE_SEC = 10;              // a measured session this short is a "glance"
const GLANCE_KEEP = 0.5;            // share of the launch points kept for a glance (penalties unaffected)
const GLANCE_ON = flag("glance", true);
// fatigue floor (F3-B), ships OFF until prompted check-ins show it helps
const FATIGUE_FLOOR_ON = flag("floor", false);
const FLOOR_FREE_HOURS = 8;         // no floor in the first 8 hrs after waking
const FLOOR_PER_HOUR = 3;           // floor points per awake hour beyond that
const FLOOR_MAX = 25;
const FLOOR_POOR_SLEEP = 5;         // extra points when today's sleep_quality context is "poor"
// prompted check-ins (F3-C)
const PROMPT_AFTER_REST_MIN = 60;   // first action after a non-sleep rest this long
const PROMPT_HIGH_LEVEL = 75;       // first time a burst reaches this
const PROMPT_RANDOM_EVERY_MIN = 180;// average spacing of random prompts while active
const PROMPT_MAX_PER_DAY = 4;
const PROMPT_MIN_GAP_MIN = 90;
// input safety (C3, D2)
const FEEL_CONFIRM_DELTA = 30;      // confirm a check-in that moves the level by 30+ points
const DOUBLE_TAP_MS = 2000;
// nudges (E1)
const NUDGE_WINDOW_MIN = 10;
// on every event, so the scoring eras can be told apart; shipping defaults give "2026-11-cap-glance"
const SCORING_VERSION = "2026-11" + "-cap" + (GLANCE_ON ? "-glance" : "") + (FATIGUE_FLOOR_ON ? "-floor" : "");
const BANDS = [[25, "calm", "Plenty of room. Go ahead."], [50, "steady", "Fine, but you're warming up."],
  [75, "loaded", "Getting heavy. A break would help."], [100, "frayed", "Overstimulated. Stop adding input; take a break."]];
const MIN = 60000;
let DOOM = { activities: ["short_videos", "social_profiles", "news"], streak: 3 }; // overridden by inventory.json

const now = () => Date.now() + (+store.get("debugSkewMs") || 0); // testers can time-travel via localStorage.debugSkewMs
const localDate = (d = new Date(now())) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const wakeDayOf = (t) => localDate(new Date(t - 4 * 60 * MIN)); // the day runs 4 AM to 4 AM
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
let lastTap = null, feelTouched = false, promptTouched = false, pendingFeel = null, lastFeel = null, leftAt = null;
let rouletteText = null, showRoulette = false, morningAns = {};
let promptQueued = null;   // F3-C: feel_source of a prompted check-in waiting to be shown
let promptShown = null;    // feel_source of the prompt card on screen
let sessionDiag = null;
let acting = false;        // true while a tap is being handled, so a prompt never shows before that tap's nudge    // ?debug=sessions: how fast the page hides and comes back after a launch

function freshState(t) {
  return {
    level: 0, updatedAt: t, startedAt: t, lastEventAt: null, lastBreakAt: null,
    opens: [],                         // [[ms, app]] stimulating launches since the last rest, last CHECK_WINDOW_MIN
    lastSwitchPenaltyAt: null, lastCheckPenaltyAt: {}, doomStreak: 0, lastOpenWakeDay: null,
    session: null,                     // {app, activity, weight, mult, startedAt, levelAtStart, launchPoints, device}
    lastClosedSessionKey: null,        // "<startedAt>|<app>" of the last session_end, so a session is closed once
    orphan: null,                      // a launch from long ago whose session_end was never logged; closed with the default length
    breakStartedAt: null, levelAtBreakStart: null, restStartAt: null,
    wakeDay: null, lastWakeDay: null, wakeAt: null, lastSleepLogAt: null,
    sleepQuality: null,                // {day, value} from the morning card
    highPrompted: false,               // F3-C: prompt_high already queued in this burst
    lastLaunchAt: null,                // F3-C: for the active time between launches (random prompts)
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
      if (!r.ok && r.status !== 409) diag(`The server rejected a ${row.event || table} record (HTTP ${r.status}); it was dropped.`);
      const cur = JSON.parse(store.get("pending") || "[]");
      cur.shift(); // success, a duplicate (409: session already closed), or a permanent client error
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
// how long a session counts when its real end is unknown: 20 min, or 45 for streaming apps (inventory sessionDefaultMin)
const defaultMinFor = (app) => (INV && INV.sessionDefaultMin && INV.sessionDefaultMin[app]) || SESSION_DEFAULT_MIN;
const nightMultFor = (actId) => (INV && INV.nightMult && INV.nightMult[actId]) || LATE_NIGHT_MULT;

// ---------- level ----------
// B9: one rest formula for breaks, auto-breaks and wake: the larger of plain decay or scaled relief, never both
function restRelief(levelBefore, minutes) {
  const decay = DECAY_PER_MIN * minutes;
  const scaled = levelBefore * BREAK_RELIEF * Math.min(1, minutes / BREAK_FULL_MIN);
  return Math.min(levelBefore, Math.max(decay, scaled));
}
const creditedMin = (minutes, cap) => Math.min(minutes, cap);
// F3-B: after a long day, rest can't take the level below a floor that grows with hours awake (never raises it)
function fatigueFloor(t) {
  if (!FATIGUE_FLOOR_ON || S.wakeAt == null) return 0;
  const hoursAwake = (t - S.wakeAt) / 3600000;
  const poor = S.sleepQuality && S.sleepQuality.day === currentWakeDay() && S.sleepQuality.value === "poor";
  return Math.max(0, Math.min(FLOOR_MAX, (hoursAwake - FLOOR_FREE_HOURS) * FLOOR_PER_HOUR)) + (poor ? FLOOR_POOR_SLEEP : 0);
}
// F1: one place that turns a rest into a level. Sleep (5+ hrs) is never capped and gets no floor.
function restOutcome(before, minutes, cap, t) {
  const sleep = minutes >= SLEEP_GAP_MIN;
  const credited = sleep ? minutes : creditedMin(minutes, cap);
  const plain = before - restRelief(before, credited);
  const after = sleep ? plain : Math.max(plain, Math.min(before, fatigueFloor(t)));
  return { credited, capped: credited < minutes, relief: before - after, after,
    floor: FATIGUE_FLOOR_ON && !sleep ? after - plain : null };
}
// an idle gap long enough to count as rest, measured from restStartAt (the end of the last session)
function idleRest(t) {
  if (S.session || pendingSession || S.breakStartedAt != null || S.restStartAt == null) return null;
  const gap = (t - S.restStartAt) / MIN;
  if (gap <= AUTO_BREAK_IDLE_MIN) return null;
  const before = Math.max(0, S.level - DECAY_PER_MIN * Math.max(0, S.restStartAt - S.updatedAt) / MIN); // level at rest start
  return { gap, before, ...restOutcome(before, gap, IDLE_REST_CAP_MIN, t) };
}
function decayed(t = now()) {
  if (S.breakStartedAt != null) return restOutcome(S.levelAtBreakStart, (t - S.breakStartedAt) / MIN, REST_CAP_MIN, t).after; // projected
  if (S.session && S.session.weight > 0) { // B1: no decay while still in a stimulating app, up to its default length
    const past = (t - S.session.startedAt) / MIN - defaultMinFor(S.session.app); // beyond that nobody knows it's still going on
    return past <= 0 ? S.level : Math.max(0, S.level - DECAY_PER_MIN * past);
  }
  const rest = idleRest(t);
  if (rest) return rest.after; // what the next action will log; frozen once the cap is reached
  return Math.max(0, S.level - DECAY_PER_MIN * Math.max(0, t - S.updatedAt) / MIN);
}
function settle(t = now()) { S.level = decayed(t); S.updatedAt = t; return S.level; }
function minsSinceBreak() { return Math.floor((now() - (S.lastBreakAt ?? S.startedAt)) / MIN); }
// the wake day of the latest wake; the 4 AM date when there is none, or it's 2+ days stale (short sleeps log no wake)
function currentWakeDay() {
  const fallback = wakeDayOf(now());
  if (!S.wakeDay || (Date.parse(fallback) - Date.parse(S.wakeDay)) / 86400000 >= 2) return fallback;
  return S.wakeDay;
}
function resetWindows() { S.opens = []; S.lastSwitchPenaltyAt = null; S.lastCheckPenaltyAt = {}; S.doomStreak = 0; S.highPrompted = false; }

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
  for (const e of ev) { // open session: newest launch not closed by anything later (a bedtime log opens none)
    if (["session_end", "break", "break_end", "auto_break", "wake", "feel"].includes(e.event)) break;
    if (e.event !== "open") continue;
    if (e.activity !== "going_to_sleep") {
      const mult = e.weight > 0 && lateNight(new Date(e.t)) ? nightMultFor(e.activity) : 1;
      const snap = { app: e.app, activity: e.activity, weight: e.weight || 0, levelAtStart: e.level_after, startedAt: e.t,
        mult, launchPoints: (e.weight || 0) * POINTS_PER_WEIGHT * mult,
        device: +store.get("sessionStart_" + e.user_id) === e.t ? DEVICE_ID : null };
      if (nowMs - e.t < SESSION_MAX_MIN * MIN) st.session = snap;
      else st.orphan = snap; // nobody came back to close it: log it with the default length at the next action
    }
    break;
  }
  for (const e of ev) { // open break: newest break with no later break_end
    if (isRest(e)) break;
    if (e.event === "break") { st.breakStartedAt = e.t; st.levelAtBreakStart = e.level_after; break; }
  }
  st.wakeDay = e0.wake_day || null;
  const wake = ev.find((e) => e.event === "wake");
  st.lastWakeDay = wake ? wake.wake_day : null;
  st.wakeAt = wake ? wake.t : null;
  const sq = ev.find((e) => e.event === "context" && e.tag === "sleep_quality");
  if (sq && sq.wake_day) st.sleepQuality = { day: sq.wake_day, value: sq.tag_value };
  const lastEnd = ev.find((e) => e.event === "session_end" && e.session_key);
  st.lastClosedSessionKey = lastEnd ? lastEnd.session_key : null;
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
  const anyOpen = ev.find((e) => e.event === "open");
  st.lastLaunchAt = anyOpen ? anyOpen.t : null;
  const lastOpen = ev.find((e) => e.event === "open" && e.activity !== "going_to_sleep");
  st.lastOpenWakeDay = lastOpen ? lastOpen.wake_day || wakeDayOf(lastOpen.t) : null; // pre-002 rows have no wake_day
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
const sessionKey = (snap) => snap.startedAt + "|" + snap.app;
function logSessionEnd(snap, minutes, endedBy) {
  const key = sessionKey(snap);
  if (S.lastClosedSessionKey === key) return; // F3-0: already closed in this tab (or one that broadcast it)
  const { cost } = applySession(snap, minutes);
  // F3-A: a measured session under GLANCE_SEC hands back part of the launch points (penalties are kept)
  let refund = 0;
  if (GLANCE_ON && (endedBy === "return" || endedBy === "next_action") && snap.weight > 0 && minutes * 60 < GLANCE_SEC) {
    refund = (1 - GLANCE_KEEP) * (snap.launchPoints ?? snap.weight * POINTS_PER_WEIGHT * snap.mult);
    S.level = clamp(S.level - refund);
  }
  S.lastClosedSessionKey = key;
  log("session_end", snap.levelAtStart, S.level, { command: "(session end)", app: snap.app, activity: snap.activity,
    activity_label: INV && INV.activities[snap.activity] ? INV.activities[snap.activity].label : null, weight: snap.weight,
    points_added: round1(cost), session_minutes: round1(minutes), ended_by: endedBy, session_key: key,
    glance_refund: refund ? round1(refund) : null });
}
function closeSession(t, reason) { // reason: return | next_action
  const snap = S.session;
  if (!snap) return;
  S.session = null;
  if (S.lastClosedSessionKey === sessionKey(snap)) return;
  const gap = (t - snap.startedAt) / MIN, dflt = defaultMinFor(snap.app);
  if (gap <= dflt) return logSessionEnd(snap, gap, reason);
  if (reason === "return") { pendingSession = { snap, gap }; applySession(snap, dflt); return; } // ask; the default until answered
  logSessionEnd(snap, dflt, "default");
}
function closeOrphan() { // a launch from a past visit that was never closed: its end is unknown, so the default length counts
  const snap = S.orphan;
  if (!snap) return;
  S.orphan = null;
  logSessionEnd(snap, defaultMinFor(snap.app), "default");
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
  const rest = idleRest(t);
  if (!rest) return;
  const { gap, before, relief, after } = rest;
  const breakAt = S.restStartAt + AUTO_BREAK_IDLE_MIN * MIN;
  S.level = after; S.updatedAt = t; S.restStartAt = t; // the rest is used up
  if (gap >= SLEEP_GAP_MIN) {
    const sleepStart = lastEventBefore ?? (t - gap * MIN);
    S.wakeDay = S.lastWakeDay = wakeDayOf(t); // a wake at 1 AM still belongs to the previous day
    S.wakeAt = t;
    S.lastBreakAt = t;
    log("wake", before, after, { command: "(wake)", break_minutes: round2(gap), relief: round1(relief),
      sleep_start: iso(sleepStart), sleep_minutes: Math.round(gap), sleep_source: sleepSource(sleepStart) });
    toast(`Good morning. ${Math.round(before)}% → ${Math.round(after)}%`);
  } else {
    S.lastBreakAt = breakAt;
    log("auto_break", before, after, { command: "(idle gap)", idle_minutes: Math.round(gap), inferred: true,
      break_at: iso(breakAt), break_minutes: round2(gap), relief: round1(relief),
      rest_credited_minutes: round2(rest.credited), rest_capped: rest.capped, floor_applied: rest.floor == null ? null : round1(rest.floor) });
    toast(`Auto-break: ${Math.round(gap)} min idle. ${Math.round(before)}% → ${Math.round(after)}%`);
    if (gap >= PROMPT_AFTER_REST_MIN) queuePrompt("prompt_rest");
  }
  resetWindows();
}

// ---------- breaks (B8) ----------
function startBreak(t) {
  const level = settle(t);
  log("break", level, level, { command: "take break", break_at: iso(t) });
  S.breakStartedAt = t; S.levelAtBreakStart = level;
  toast(`Break started. Counts up to ${REST_CAP_MIN} min. Full effect at ${BREAK_FULL_MIN} min.`);
}
function endBreak(t) {
  const start = S.breakStartedAt, before = S.levelAtBreakStart;
  if (start == null) return;
  const minutes = (t - start) / MIN, rest = restOutcome(before, minutes, REST_CAP_MIN, t), after = rest.after;
  S.breakStartedAt = null; S.levelAtBreakStart = null;
  S.level = after; S.updatedAt = t; S.restStartAt = t; S.lastBreakAt = t;
  resetWindows();
  log("break_end", before, after, { command: "end break", break_minutes: round2(minutes), relief: round1(rest.relief),
    rest_credited_minutes: round2(rest.credited), rest_capped: rest.capped, floor_applied: rest.floor == null ? null : round1(rest.floor) });
  if (minutes >= SLEEP_GAP_MIN) { // slept through an open break (uncapped): the break already brought the level down
    S.wakeDay = S.lastWakeDay = wakeDayOf(t);
    S.wakeAt = t;
    log("wake", after, after, { command: "(wake)", break_minutes: round2(minutes), relief: 0,
      sleep_start: iso(start), sleep_minutes: Math.round(minutes), sleep_source: sleepSource(start) });
  } else if (minutes >= PROMPT_AFTER_REST_MIN) queuePrompt("prompt_rest");
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
  if (!acting) { acting = true; queueMicrotask(() => { acting = false; render(); }); } // runs once the whole tap is done
  if (kind !== "context") { // context chips don't close a session or end a break
    if (pendingSession) resolvePending(defaultMinFor(pendingSession.snap.app), "default");
    closeOrphan();
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
// delayMs: copy first, then wait before opening the site (the first launch of the day and the roulette "morning" mode).
// The wait starts once the copy has finished and stays inside the browser's window after a tap for opening a tab.
function openRoulette(text, why = "Lots of overstimulation", siteOpen = false, delayMs = 0) {
  if (!INV || !INV.roulette) return;
  text = text || INV.roulette.clipboard;
  rouletteText = text; showRoulette = true; // keep the button around in case the extra tab is blocked
  const open = () => { if (!siteOpen) window.open(INV.roulette.url, "_blank", "noopener"); };
  const then = (msg) => { toast(msg); if (delayMs) setTimeout(open, delayMs); else open(); };
  let copy;
  try { copy = navigator.clipboard.writeText(text); } catch { copy = Promise.reject(); }
  if (!delayMs) { // nothing to wait for: open inside the tap, as before
    copy.then(() => toast(`${why}: list copied, opening the roulette.`), () => toast(`${why}: opening the roulette (couldn't copy the list).`));
    open();
  } else {
    copy.then(() => then(`${why}: list copied. Opening the roulette in a second.`),
      () => then(`${why}: opening the roulette (couldn't copy the list).`));
  }
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
    openRoulette(INV.roulette && INV.roulette.morning, "First launch of the day", siteOpen, INV.roulette && INV.roulette.delayMs);
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
  const copyMode = !!(INV.roulette && (INV.roulette.copyActivities || []).includes(actId)); // roulette "morning" mode: copy, wait, then open
  if (url && !copyMode) window.open(url, "_blank", "noopener"); // must happen synchronously inside the tap; dummy launches have no url
  if (url && store.get("debugSessions")) sessionDiag = { app: appKey, at: performance.now(), hiddenAt: null };
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
  // F2: first launch of the wake day (4 AM to 4 AM, or from the last wake), not of the calendar date
  const wd = currentWakeDay(); // after beginAction(), so a wake due now has been logged
  const prevWd = [S.lastOpenWakeDay, store.get("lastOpenWD_" + userId)].filter(Boolean).sort().pop();
  const firstOfDay = actId !== "going_to_sleep" && prevWd !== wd; // a bedtime log doesn't use up the day's first launch
  if (actId !== "going_to_sleep") { S.lastOpenWakeDay = wd; store.set("lastOpenWD_" + userId, wd); }
  else S.lastSleepLogAt = t;
  // F3-C: prompted check-ins, the first time a burst gets high and at random during active use
  if (!S.highPrompted && before < PROMPT_HIGH_LEVEL && S.level >= PROMPT_HIGH_LEVEL) { S.highPrompted = true; queuePrompt("prompt_high"); }
  const activeMin = S.lastLaunchAt == null ? 0 : Math.min(30, (t - S.lastLaunchAt) / MIN);
  if (Math.random() < activeMin / PROMPT_RANDOM_EVERY_MIN) queuePrompt("prompt_random");
  S.lastLaunchAt = t;
  const doomscrolling = S.doomStreak > 0 && S.doomStreak % DOOM.streak === 0;
  log("open", before, S.level, { command: `${appKey} ${actId}`, app: appKey, activity: actId, activity_label: act.label,
    weight: act.weight, points_added: round1(points), switch_penalty: round1(sw), check_penalty: round1(ck * mult),
    repeat_count: repeat, url });
  toast(`${appKey}: ${points > 0 ? "+" : ""}${Math.round(points)}%${sw ? " (app-switching penalty)" : ""}${ck ? " (checking loop)" : ""}${mult > 1 ? " (late night x" + mult + ": prioritise sleep)" : ""}`);
  if (actId !== "going_to_sleep") { // the time spent is costed when you come back or act again (sessions); weight 0 and no-link launches count too
    S.session = { app: appKey, activity: actId, weight: act.weight, mult, startedAt: t, levelAtStart: S.level,
      launchPoints: act.weight * POINTS_PER_WEIGHT * mult, device: DEVICE_ID }; // launchPoints: what a glance hands half of back
    store.set("sessionStart_" + userId, String(t));
  }
  finishAction(t);
  let nudged;
  if (copyMode) {
    openRoulette(INV.roulette.morning, "Morning reflections", false, INV.roulette.delayMs);
    if (firstOfDay) newNudge("morning_roulette");
    nudged = true;
  } else nudged = maybeRoulette(before, S.level, doomscrolling, firstOfDay, appKey === "roulette");
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

// C3: the button only works after the slider moved; big jumps need a confirm.
// card "self" is the check-in card; "prompt" is the prompted card (F3-C), logged with its feel_source.
const FEEL_UI = { self: ["feel", "feelConfirm", "feelConfirmQ", "feelYes"], prompt: ["promptFeel", "promptConfirm", "promptConfirmQ", "promptYes"] };
const feelSource = (card) => (card === "self" ? "self" : promptShown || "prompt_random");
function submitFeel(card) {
  const [slider, box, q, yes] = FEEL_UI[card];
  if (card === "self" ? !feelTouched : !promptTouched) return;
  const v = +$(slider).value, cur = decayed();
  if (Math.abs(v - cur) >= FEEL_CONFIRM_DELTA) {
    pendingFeel = { v, card };
    $(q).innerHTML = `The app thinks you're at <strong>${Math.round(cur)}%</strong>. Set it to <strong>${v}%</strong>?`;
    $(yes).textContent = `Yes, set ${v}%`;
    $(box).hidden = false;
    return;
  }
  setFeel(v, false, feelSource(card));
}
function setFeel(v, confirmed, source = "self") {
  if (!tapOk("feel")) return;
  $("feelConfirm").hidden = true; $("promptConfirm").hidden = true; pendingFeel = null;
  const t = beginAction("feel");
  const before = settle(t);
  S.level = v;
  log("feel", before, v, { command: "feel", felt: v, computed_level: Math.round(before), feel_confirmed: confirmed, feel_source: source });
  if (source !== "self") { promptShown = null; promptTouched = false; }
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

// F3-C: prompts are limited per wake day and spaced out; skipping changes nothing but still counts
function promptAllowed(t) {
  let c = {};
  try { c = JSON.parse(store.get("promptCount_" + userId) || "{}"); } catch {}
  const shownToday = c.day === currentWakeDay() ? c.n : 0;
  return shownToday < PROMPT_MAX_PER_DAY && t - (+store.get("promptLastAt_" + userId) || 0) >= PROMPT_MIN_GAP_MIN * MIN;
}
function queuePrompt(source) { if (!promptQueued && !promptShown && promptAllowed(now())) promptQueued = source; }
function maybeShowPrompt(t) { // held while a morning card or an unresolved nudge is on screen
  if (acting || !promptQueued || promptShown || morningDue(t)) return;
  if (S.nudge && (t - S.nudge.at) / MIN <= NUDGE_WINDOW_MIN) return;
  const source = promptQueued;
  promptQueued = null;
  if (!promptAllowed(t)) return;
  let c = {};
  try { c = JSON.parse(store.get("promptCount_" + userId) || "{}"); } catch {}
  const day = currentWakeDay();
  store.set("promptCount_" + userId, JSON.stringify({ day, n: (c.day === day ? c.n : 0) + 1 }));
  store.set("promptLastAt_" + userId, String(t));
  promptShown = source; promptTouched = false;
  $("promptFeel").value = 50; $("promptVal").textContent = "50"; // no carry-over from the last answer
}
function skipPrompt() { promptShown = null; $("promptConfirm").hidden = true; render(); }

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
  if (tag === "sleep_quality") S.sleepQuality = { day: currentWakeDay(), value }; // for the fatigue floor
  if (morningAns.sleep_quality && morningAns.day_load) store.set("morningDone_" + userId, currentWakeDay());
  finishAction(t);
}
function skipMorning() { store.set("morningDone_" + userId, currentWakeDay()); render(); }
function morningDue(t) {
  const doneDay = store.get("morningDone_" + userId);
  // a launch that never closed (a meal logged before bed, no link to come back from) must not hide the morning card
  const restStart = S.session ? S.session.startedAt : S.restStartAt;
  const resting = restStart != null && !pendingSession && S.breakStartedAt == null
    && (!S.session || (t - S.session.startedAt) / MIN >= SLEEP_GAP_MIN);
  const byGap = resting && (t - restStart) / MIN >= SLEEP_GAP_MIN && doneDay !== wakeDayOf(t);
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
    : S.session && (t - S.session.startedAt) / MIN <= SESSION_MAX_MIN ? `In ${S.session.app} · ${Math.floor((t - S.session.startedAt) / MIN)} min`
    : S.lastBreakAt ? `${minsSinceBreak()} min since last break` : `No break yet (${minsSinceBreak()} min since you started)`;
  $("breakBtn").textContent = onBreak ? `End break · ${breakMin} min · Counts up to ${REST_CAP_MIN} min. Full effect at ${BREAK_FULL_MIN} min.` : "Take a break";
  $("sessQ").hidden = !pendingSession;
  if (pendingSession) $("sessQText").textContent = `How long were you on ${pendingSession.snap.app}?`;
  $("morning").hidden = !morningDue(t);
  document.querySelectorAll("[data-morning]").forEach((b) => {
    const [tag, value] = b.dataset.morning.split(":");
    b.className = morningAns[tag] === value ? "" : "ghost";
  });
  $("feelBtn").disabled = !feelTouched; $("feelHint").hidden = feelTouched;
  maybeShowPrompt(t);
  $("prompt").hidden = !promptShown;
  $("promptBtn").disabled = !promptTouched; $("promptHint").hidden = promptTouched;
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
  $("feelBtn").onclick = () => submitFeel("self");
  $("promptFeel").oninput = () => {
    $("promptVal").textContent = $("promptFeel").value;
    promptTouched = true; $("promptConfirm").hidden = true; pendingFeel = null;
    if (S) render();
  };
  $("promptBtn").onclick = () => submitFeel("prompt");
  $("promptSkip").onclick = skipPrompt;
  const confirmYes = () => pendingFeel && setFeel(pendingFeel.v, true, feelSource(pendingFeel.card));
  const confirmNo = () => { $("feelConfirm").hidden = true; $("promptConfirm").hidden = true; pendingFeel = null; };
  $("feelYes").onclick = confirmYes; $("promptYes").onclick = confirmYes;
  $("feelNo").onclick = confirmNo; $("promptNo").onclick = confirmNo;
  $("rouletteBtn").onclick = tapRoulette;
  $("breakBtn").onclick = takeBreak; $("fbBtn").onclick = sendText;
  document.querySelectorAll("[data-acc]").forEach((b) => (b.onclick = () => sendAccuracy(b.dataset.acc === "1")));
  document.querySelectorAll("[data-sess]").forEach((b) => (b.onclick = () => answerSession(b.dataset.sess)));
  $("sessDismiss").onclick = () => { if (pendingSession) resolvePending(defaultMinFor(pendingSession.snap.app), "default"); render(); };
  document.querySelectorAll("[data-morning]").forEach((b) => (b.onclick = () => answerMorning(...b.dataset.morning.split(":"))));
  $("morningSkip").onclick = skipMorning;
  document.querySelectorAll("[data-ctx]").forEach((b) => (b.onclick = () => tapContext(b.dataset.ctx, "yes")));
  $("logout").onclick = () => { store.del("uid"); location.reload(); };
  setInterval(() => { try { render(); } catch {} }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { leftAt = now(); if (sessionDiag && sessionDiag.hiddenAt == null) sessionDiag.hiddenAt = performance.now(); }
    else {
      if (sessionDiag && sessionDiag.hiddenAt != null) { // ?debug=sessions: is a 0 s session real or the browser bouncing back?
        diag(`${sessionDiag.app}: page hid ${Math.round(sessionDiag.hiddenAt - sessionDiag.at)} ms after launch, back ${Math.round(performance.now() - sessionDiag.hiddenAt)} ms later`);
        sessionDiag = null;
      }
      onVisible();
    }
  });
  if (/[?&]debug=sessions\b/.test(location.search)) store.set("debugSessions", "1");

  const saved = store.get("uid");
  if (saved && C.USER_IDS.includes(saved)) start(saved).catch((e) => diag("Couldn't start: " + e.message));
  else { try { $("uid").focus(); } catch {} }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
