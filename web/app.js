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
const BANDS = [[25, "calm", "Plenty of room. Go ahead."], [50, "steady", "Fine, but you're warming up."],
  [75, "loaded", "Getting heavy. A break would help."], [100, "frayed", "Overstimulated. Stop adding input; take a break."]];
const MIN = 60000;

let INV = null, userId = null, S = null; // S = {level, updatedAt, lastCmdAt, lastBreakAt, startedAt, recent:[[ms,app]]}

const bandOf = (l) => BANDS.find((b) => l <= b[0]);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

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
      store.set("inv", text);
      return INV;
    } catch (e) { lastErr = e; }
  }
  const cached = store.get("inv"); // fall back to the last good copy
  if (cached) { try { INV = JSON.parse(cached); diag("Couldn't refresh the app list; using a saved copy."); return INV; } catch {} }
  throw new Error("Couldn't load the app list (inventory.json): " + ((lastErr && lastErr.message) || lastErr));
}

// ---------- state ----------
function decayed() { return Math.max(0, S.level - DECAY_PER_MIN * (Date.now() - S.updatedAt) / MIN); }
function settle() { S.level = decayed(); S.updatedAt = Date.now(); return S.level; }
function minsSinceBreak() { return Math.floor((Date.now() - (S.lastBreakAt ?? S.startedAt)) / MIN); }

async function loadState() {
  const q = `events?user_id=eq.${encodeURIComponent(userId)}`;
  const [last, brk, first, recent] = await Promise.all([
    sbGet(`${q}&order=ts.desc,id.desc&limit=1&select=ts,level_after`),
    sbGet(`${q}&event=in.(break,auto_break)&order=ts.desc,id.desc&limit=1&select=break_at`),
    sbGet(`${q}&order=ts.asc,id.asc&limit=1&select=ts`),
    sbGet(`${q}&event=eq.open&ts=gte.${new Date(Date.now() - SWITCH_WINDOW_MIN * MIN).toISOString()}&select=ts,app`),
  ]);
  const t = last[0] ? Date.parse(last[0].ts) : null;
  S = {
    level: last[0] ? last[0].level_after : 0, updatedAt: t ?? Date.now(), lastCmdAt: t,
    lastBreakAt: brk[0]?.break_at ? Date.parse(brk[0].break_at) : null,
    startedAt: first[0] ? Date.parse(first[0].ts) : Date.now(),
    recent: recent.map((r) => [Date.parse(r.ts), r.app]),
  };
}

// ---------- logging (same fields as the CLI's log.txt, plus user_id) ----------
function log(event, before, after, extra = {}) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  sbPost("events", {
    user_id: userId, ts: d.toISOString(),
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, // tester's local date/hour
    hour: d.getHours(), weekday: d.toLocaleDateString("en-US", { weekday: "short" }),
    event, level_before: Math.round(before), band_before: bandOf(before)[1],
    level_after: Math.round(after), band_after: bandOf(after)[1],
    mins_since_break: minsSinceBreak(),
    last_break_at: S.lastBreakAt ? new Date(S.lastBreakAt).toISOString() : null,
    break_taken_yet: S.lastBreakAt != null, ...extra,
  });
}

// ---------- actions ----------
function maybeAutoBreak() {
  if (!S.lastCmdAt) return;
  const idle = (Date.now() - S.lastCmdAt) / MIN;
  if (idle <= AUTO_BREAK_IDLE_MIN) return;
  const before = settle();
  S.level = before * (1 - BREAK_RELIEF);
  const breakAt = S.lastCmdAt + AUTO_BREAK_IDLE_MIN * MIN;
  log("auto_break", before, S.level, { command: "(idle gap)", idle_minutes: Math.round(idle), inferred: true,
    break_at: new Date(breakAt).toISOString() });
  S.lastBreakAt = breakAt; S.recent = [];
  toast(`Auto-break: ${Math.round(idle)} min idle. ${Math.round(before)}% → ${Math.round(S.level)}%`);
}
function done() { S.lastCmdAt = Date.now(); render(); }

function openApp(appKey, actId) {
  const a = INV.apps[appKey], act = INV.activities[actId];
  const url = INV.urlOverrides[`${appKey}|${actId}`] || a.url;
  window.open(url, "_blank", "noopener"); // must happen synchronously inside the tap
  maybeAutoBreak();
  const before = settle();
  const now = Date.now();
  S.recent = S.recent.filter((r) => r[0] >= now - SWITCH_WINDOW_MIN * MIN);
  if (act.weight > 0) S.recent.push([now, appKey]); // calming launches don't count as switching
  let points = act.weight * POINTS_PER_WEIGHT;
  if (act.weight > 0 && new Set(S.recent.map((r) => r[1])).size >= SWITCH_APPS) points += INV.activities.app_switching.weight * POINTS_PER_WEIGHT;
  S.level = Math.max(0, Math.min(100, before + points));
  const penalty = points - act.weight * POINTS_PER_WEIGHT;
  log("open", before, S.level, { command: `${appKey} ${actId}`, app: appKey, activity: actId, activity_label: act.label,
    weight: act.weight, points_added: +points.toFixed(1), switch_penalty: +penalty.toFixed(1), url });
  toast(`${appKey}: ${points > 0 ? "+" : ""}${Math.round(points)}%${penalty ? " (app-switching penalty)" : ""}`);
  done();
}

function takeBreak() {
  const before = settle();
  S.level = before * (1 - BREAK_RELIEF);
  const at = Date.now();
  log("break", before, S.level, { command: "take break", break_at: new Date(at).toISOString() });
  S.lastBreakAt = at; S.recent = [];
  toast(`Break logged: ${Math.round(before)}% → ${Math.round(S.level)}%`);
  done();
}

let lastFeel = null;
function setFeel() {
  maybeAutoBreak();
  const v = +$("feel").value, before = settle();
  S.level = v;
  log("feel", before, v, { command: "feel", felt: v, computed_level: Math.round(before) });
  lastFeel = { felt: v, computed: Math.round(before) };
  $("accQ").textContent = `The app estimated ${lastFeel.computed}% and you said ${v}%. Was the estimate:`;
  $("accBox").hidden = false;
  done();
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

// ---------- render ----------
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = "none"), 3500);
}
function render() {
  if (!S) return;
  const l = decayed(), [, name, comment] = bandOf(l);
  const color = `var(--${name})`;
  $("pct").textContent = Math.round(l);
  $("band").textContent = name.toUpperCase(); $("band").style.color = color;
  $("fill").style.width = l + "%"; $("fill").style.background = color;
  $("comment").textContent = comment;
  $("since").textContent = S.lastBreakAt ? `${minsSinceBreak()} min since last break`
    : `No break yet (${minsSinceBreak()} min since you started)`;
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
      b.textContent = actId === a.default ? `Open ${key}` : `${act.modes[0] || act.label} (${act.weight})`;
      b.onclick = () => openApp(key, actId);
      chips.appendChild(b);
    }
    card.appendChild(chips); box.appendChild(card);
  }
}

// ---------- session ----------
async function start(id) {
  userId = id; store.set("uid", id);
  $("login").hidden = true; $("appview").hidden = false; $("who").textContent = id;
  S = null;
  // inventory and state load in parallel; either failing is reported, not fatal to the page
  const invP = loadInventory().then(renderApps).catch((e) => diag(e.message));
  try { await loadState(); } catch (e) {
    toast("Can't reach server; starting fresh.");
    S = { level: 0, updatedAt: Date.now(), lastCmdAt: null, lastBreakAt: null, startedAt: Date.now(), recent: [] };
  }
  render(); flush();
  await invP;
}

function normId(s) { // tolerate full-width chars, zero-width chars, stray spaces, caps
  return String(s || "").normalize("NFKC").replace(/[​-‍﻿\s]/g, "").toLowerCase();
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
  $("feel").oninput = () => ($("feelVal").textContent = $("feel").value);
  $("feelBtn").onclick = setFeel; $("breakBtn").onclick = takeBreak; $("fbBtn").onclick = sendText;
  document.querySelectorAll("[data-acc]").forEach((b) => (b.onclick = () => sendAccuracy(b.dataset.acc === "1")));
  $("logout").onclick = () => { store.del("uid"); location.reload(); };
  setInterval(() => { try { render(); } catch {} }, 30000);
  document.addEventListener("visibilitychange", () => !document.hidden && render());

  const saved = store.get("uid");
  if (saved && C.USER_IDS.includes(saved)) start(saved).catch((e) => diag("Couldn't start: " + e.message));
  else { try { $("uid").focus(); } catch {} }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
