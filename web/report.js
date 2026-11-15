"use strict";
// End-of-day overstimulation report. Computed on demand in the browser from the tester's own events,
// saved per day in public.daily_analysis, and re-computed with "Redo analysis".
// A day is a wake day: 4 AM to 4 AM local time (the same boundary the launcher uses for "first launch of the day").
const $ = (id) => document.getElementById(id);
const C = window.CONFIG || { SUPABASE_URL: "", SUPABASE_KEY: "", USER_IDS: [] };
const ANALYSIS_VERSION = "1";
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const BANDS = [[25, "calm"], [50, "steady"], [75, "loaded"], [100, "frayed"]];
const BAND_NAMES = BANDS.map((b) => b[1]);
const bandOf = (l) => BANDS.find((b) => l <= b[0])[1];
const LATE_START = 22, LATE_END = 5; // the launcher's late-night window (stimulating launches count 1.5x)
const DIMENSIONS = [ // checked list: what counts as done for each dimension
  { key: "mental", name: "Mental", what: "7 Habits logged", test: (o) => o.app === "7-habits", need: 1 },
  { key: "physical", name: "Physical", what: "Surya namaskar launched", test: (o) => o.app === "surya namaskar", need: 1 },
  { key: "spiritual", name: "Spiritual", what: "Bhagwat Gita launched", test: (o) => o.app === "gita a day", need: 1 },
  { key: "social", name: "Social", what: "WhatsApp trusted mode launched more than 10 times", test: (o) => o.app === "whatsapp" && o.activity === "trusted_msg", need: 11 },
];
const RESTS = ["auto_break", "break_end", "wake"];
let INV = null, userId = null, EVENTS = [], DAYS = new Map(), A = null, SAVED = new Set(), savedAt = null;

// ---------- small helpers ----------
const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayKeyOf = (ms) => dateKey(new Date(ms - 4 * HOUR));
const dayStartOf = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d, 4, 0, 0).getTime(); };
const fmtT = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtDay = (key) => new Date(dayStartOf(key)).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const fmtMin = (m) => (m == null ? "–" : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`);
const r1 = (x) => Math.round(x * 10) / 10;
const sum = (a, f = (x) => x) => a.reduce((s, x) => s + (f(x) || 0), 0);
const lateNight = (ms) => { const h = new Date(ms).getHours(); return h >= LATE_START || h < LATE_END; };
const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const mean = (a) => (a.length ? sum(a) / a.length : null);
const signed = (x, d = 1) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(d ? r1(x) : Math.round(x));
function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (text != null) e.textContent = text; // data (app names, labels) only ever goes in as text
  return e;
}
const SVGNS = "http://www.w3.org/2000/svg";
function sv(tag, attrs = {}, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}
function modeOf(app, activity) {
  const a = INV && INV.apps[app], act = INV && INV.activities[activity];
  const label = act ? act.label : activity;
  if (!a || a.default === activity) return { mode: "default", label };
  return { mode: (act && act.modes[0]) || activity, label };
}

// ---------- data ----------
function headers(extra = {}) {
  const h = { apikey: C.SUPABASE_KEY, "Content-Type": "application/json", ...extra };
  if (C.SUPABASE_KEY.startsWith("eyJ")) h.Authorization = "Bearer " + C.SUPABASE_KEY;
  return h;
}
async function sbGetAll(path) { // PostgREST returns at most 1000 rows a request: page through
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${C.SUPABASE_URL}/rest/v1/${path}&limit=1000&offset=${off}`, { headers: headers() });
    if (!r.ok) throw new Error(await r.text());
    const page = await r.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}
async function loadEvents() {
  const since = new Date(Date.now() - 60 * DAY).toISOString();
  const rows = await sbGetAll(`events?user_id=eq.${encodeURIComponent(userId)}&ts=gte.${since}&order=ts.asc,id.asc&select=*`);
  EVENTS = rows.map((r) => ({ ...r, t: Date.parse(r.ts) }));
  DAYS = new Map();
  for (const r of EVENTS) { const k = dayKeyOf(r.t); if (!DAYS.has(k)) DAYS.set(k, []); DAYS.get(k).push(r); }
}
async function loadSavedList() {
  const rows = await sbGetAll(`daily_analysis?user_id=eq.${encodeURIComponent(userId)}&select=wake_day`);
  SAVED = new Set(rows.map((r) => r.wake_day));
}
async function loadSaved(day) {
  const r = await fetch(`${C.SUPABASE_URL}/rest/v1/daily_analysis?user_id=eq.${encodeURIComponent(userId)}&wake_day=eq.${day}&select=*`, { headers: headers() });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json())[0] || null;
}
async function save(day, analysis) {
  const r = await fetch(`${C.SUPABASE_URL}/rest/v1/daily_analysis?on_conflict=user_id,wake_day`, {
    method: "POST", headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ user_id: userId, wake_day: day, created_at: new Date().toISOString(), analysis_version: ANALYSIS_VERSION, analysis }),
  });
  if (!r.ok) throw new Error(`Couldn't save the analysis (HTTP ${r.status})`);
  SAVED.add(day);
}

// ---------- analysis (pure: rows of one day in, a plain object out; this object is what gets saved) ----------
function dedupe(rows) {
  // 1. identical rows posted twice (two tabs flushing the same queue)
  const seen = new Set(), out = [], identical = [];
  for (const r of rows) {
    const k = [r.event, r.ts, r.app, r.activity, r.nudge_id, r.session_key, r.tag, r.felt].join("|");
    if (seen.has(k)) { identical.push(r); continue; }
    seen.add(k); out.push(r);
  }
  // 2. the same session closed twice (once by each tab), with keys a few ms apart: keep the first close
  const kept = [], dupSessions = [];
  const startOf = (r) => (r.session_key ? +r.session_key.split("|")[0] : r.t - (+r.session_minutes || 0) * MIN);
  for (const r of out) {
    if (r.event !== "session_end") { kept.push(r); continue; }
    const s = startOf(r);
    const twin = kept.find((k) => k.event === "session_end" && k.app === r.app && Math.abs(startOf(k) - s) <= 2000);
    if (twin) { dupSessions.push(r); continue; }
    kept.push(r);
  }
  return { rows: kept, identical, dupSessions };
}
function buildCurve(rows) {
  // level over time: a step at each event (before -> after); rests are drawn as a slope, since the level
  // came down over the rest rather than at the tap that logged it
  const pts = [];
  for (const r of rows) {
    if (r.level_after == null) continue;
    if (!RESTS.includes(r.event) && r.level_before != null) pts.push([r.t, r.level_before]);
    pts.push([r.t, r.level_after]);
  }
  return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
}
function levelAt(curve, t) {
  if (!curve.length || t < curve[0][0] || t > curve[curve.length - 1][0]) return null;
  let lo = 0, hi = curve.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (curve[m][0] <= t) lo = m; else hi = m; }
  const [t0, v0] = curve[lo], [t1, v1] = curve[hi];
  return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}

function analyze(dayRows, day) {
  const start = dayStartOf(day), end = start + DAY;
  const { rows, identical, dupSessions } = dedupe(dayRows);
  const ev = (n) => rows.filter((r) => r.event === n);
  const opens = ev("open").map((r) => {
    const m = modeOf(r.app, r.activity);
    return { t: r.t, app: r.app, activity: r.activity, label: m.label, mode: m.mode, weight: r.weight || 0,
      points: +r.points_added || 0, before: r.level_before, after: r.level_after, band: r.band_after,
      sw: +r.switch_penalty || 0, ck: +r.check_penalty || 0 };
  });
  const counted = opens.filter((o) => o.activity !== "back_to_work"); // "Back to work" is a marker, not a launch
  const sessions = ev("session_end").map((r) => {
    const s = r.session_key ? +r.session_key.split("|")[0] : r.t - (+r.session_minutes || 0) * MIN;
    return { start: s, end: s + (+r.session_minutes || 0) * MIN, app: r.app, activity: r.activity, minutes: +r.session_minutes || 0,
      endedBy: r.ended_by, weight: r.weight || 0, refund: +r.glance_refund || 0, levelStart: r.level_before, levelEnd: r.level_after,
      points: +r.points_added || 0 };
  });
  for (const o of opens) {
    const s = sessions.find((x) => x.app === o.app && Math.abs(x.start - o.t) <= 2000);
    o.session = s ? { minutes: s.minutes, endedBy: s.endedBy, refund: s.refund } : null;
  }
  const curve = buildCurve(rows);
  const first = rows.length ? rows[0].t : start, last = rows.length ? rows[rows.length - 1].t : start;
  const now = Date.now(), inProgress = now >= start && now < end;

  // time in each band, minute by minute between first and last use
  const bandMinutes = { calm: 0, steady: 0, loaded: 0, frayed: 0 };
  for (let t = first; t < last; t += MIN) { const l = levelAt(curve, t); if (l != null) bandMinutes[bandOf(l)]++; }

  const wakeRow = ev("wake")[0];
  const peakRow = rows.reduce((p, r) => (r.level_after != null && (!p || r.level_after > p.level_after) ? r : p), null);
  let peak = null;
  if (peakRow) {
    const o = opens.find((x) => x.t === peakRow.t);
    const refundRow = sessions.find((s) => o && s.app === o.app && Math.abs(s.start - o.t) <= 2000 && s.refund);
    peak = { level: peakRow.level_after, t: peakRow.t, app: o ? o.app : null, mode: o ? o.mode : null,
      afterRefund: refundRow ? refundRow.levelEnd : null };
  }
  const feels = ev("feel").map((r) => ({ t: r.t, felt: +r.felt, computed: r.computed_level, gap: +r.felt - r.computed_level,
    confirmed: r.feel_confirmed, source: r.feel_source || "self" }));
  const nudgeIds = [...new Set(ev("nudge").map((r) => r.nudge_id))];
  const nudges = nudgeIds.map((id) => {
    const n = rows.find((r) => r.event === "nudge" && r.nudge_id === id);
    const o = rows.filter((r) => r.event === "nudge_outcome" && r.nudge_id === id).pop();
    return { id, t: n.t, reason: n.nudge_reason, outcome: o ? o.nudge_outcome : "open", responseMin: o && o.response_min != null ? +o.response_min : null };
  });
  const dupNudgeRows = ev("nudge").length - nudgeIds.length;
  const rests = rows.filter((r) => RESTS.includes(r.event)).map((r) => ({ t: r.t, kind: r.event, minutes: +r.break_minutes || 0,
    credited: r.rest_credited_minutes != null ? +r.rest_credited_minutes : null, capped: !!r.rest_capped,
    before: r.level_before, after: r.level_after, sleepMinutes: r.sleep_minutes }));
  const autoBreaks = rests.filter((r) => r.kind === "auto_break");

  // by hour, from 4 AM
  const byHour = Array.from({ length: 24 }, (_, i) => ({ i, t: start + i * HOUR, launches: 0, net: 0, added: 0, removed: 0, peak: null, minutes: 0 }));
  const slot = (t) => Math.max(0, Math.min(23, Math.floor((t - start) / HOUR)));
  for (const o of counted) { const h = byHour[slot(o.t)]; h.launches++; h.net += o.points; if (o.points > 0) h.added += o.points; else h.removed += o.points; }
  for (const r of rows) if (r.level_after != null) { const h = byHour[slot(r.t)]; h.peak = Math.max(h.peak ?? 0, r.level_after); }
  for (const s of sessions) byHour[slot(s.start)].minutes += s.minutes;

  // by app
  const apps = new Map();
  for (const o of counted) {
    if (!apps.has(o.app)) apps.set(o.app, { app: o.app, launches: 0, net: 0, minutes: 0, noSession: 0 });
    const a = apps.get(o.app); a.launches++; a.net += o.points;
    if (!o.session && o.activity !== "going_to_sleep") a.noSession++;
  }
  for (const s of sessions) if (apps.has(s.app)) apps.get(s.app).minutes += s.minutes;
  const byApp = [...apps.values()].sort((a, b) => b.net - a.net || b.launches - a.launches);

  const dims = DIMENSIONS.map((d) => { const n = opens.filter(d.test).length; return { key: d.key, name: d.name, what: d.what, count: n, need: d.need, done: n >= d.need }; });

  const s = {
    firstUse: first, lastUse: last, inProgress,
    wake: wakeRow ? { t: wakeRow.t, sleepMinutes: wakeRow.sleep_minutes } : null,
    launchesAll: opens.length, launches: counted.length, backToWork: opens.length - counted.length,
    net: r1(sum(counted, (o) => o.points)), added: r1(sum(counted.filter((o) => o.points > 0), (o) => o.points)),
    removed: r1(sum(counted.filter((o) => o.points < 0), (o) => o.points)),
    glance: r1(sum(sessions, (x) => x.refund)),
    bands: Object.fromEntries(BAND_NAMES.map((b) => [b, opens.filter((o) => o.band === b).length])),
    peak, timeInApps: r1(sum(sessions, (x) => x.minutes)),
    manualBreaks: rests.filter((r) => r.kind === "break_end").length,
    idleBreaks: autoBreaks.length, idleCapped: autoBreaks.filter((r) => r.capped).length,
    checkins: feels.length, checkinGap: feels.length ? r1(mean(feels.map((f) => Math.abs(f.gap)))) : null,
    nudges: nudges.length, nudgesFollowed: nudges.filter((n) => ["break", "calming", "roulette"].includes(n.outcome)).length,
    nudgesOpen: nudges.filter((n) => n.outcome === "open").length,
    dimsDone: dims.filter((d) => d.done).length,
  };
  s.effective = r1(s.net - s.glance);
  const out = { version: ANALYSIS_VERSION, day, user: userId, computedAt: now, start, end, summary: s, bandMinutes,
    curve, launches: opens, sessions, rests, byHour, byApp, feels, nudges, dims };
  out.moments = keyMoments(out);
  out.problems = loggingProblems(out, { identical, dupSessions, dupNudgeRows, rows });
  return out;
}

function keyMoments(a) {
  const m = [], L = a.launches, stim = L.filter((o) => o.weight > 0);
  if (a.summary.wake) {
    const morning = a.nudges.find((n) => n.reason === "morning_roulette" && Math.abs(n.t - a.summary.wake.t) < 30 * MIN);
    m.push({ t: a.summary.wake.t, text: `Wake after ${fmtMin(a.summary.wake.sleepMinutes)} of sleep.${morning ? " The morning roulette fired on the first launch." : ""}` });
  }
  // bursts: 4+ stimulating launches, each within 3 min of the last
  for (let i = 0; i < stim.length;) {
    let j = i;
    while (j + 1 < stim.length && stim[j + 1].t - stim[j].t <= 3 * MIN) j++;
    if (j - i + 1 >= 4) {
      const b = stim.slice(i, j + 1), apps = [...new Set(b.map((o) => o.app))];
      const ck = sum(b, (o) => o.ck), sw = sum(b, (o) => o.sw);
      let text = `${b.length} launches in ${Math.max(1, Math.round((b[b.length - 1].t - b[0].t) / MIN))} min (${apps.join(", ")}). Level ${b[0].before} → ${b[b.length - 1].after}`;
      if (ck || sw) text += `, including ${[ck ? `${r1(ck)} checking-loop` : "", sw ? `${r1(sw)} switching` : ""].filter(Boolean).join(" and ")} penalty points`;
      const f = a.feels.find((x) => x.t > b[0].t && x.t - b[b.length - 1].t < 30 * MIN);
      if (f) text += `. You reported felt ${f.felt} at ${fmtT(f.t)} (tracker ${f.computed})`;
      m.push({ t: b[0].t, text: text + "." });
    }
    i = j + 1;
  }
  for (let i = 1; i < L.length; i++) { // long quiet stretches
    const gap = L[i].t - L[i - 1].t;
    if (gap >= 2 * HOUR) m.push({ t: L[i - 1].t, text: `No launches for ${fmtMin(gap / MIN)} (until ${fmtT(L[i].t)}).` });
  }
  const lateFirst = stim.find((o) => lateNight(o.t) && o.t > a.start + 12 * HOUR);
  if (lateFirst) m.push({ t: lateFirst.t, text: `${lateFirst.app} (${lateFirst.label}). From here the late-night 1.5× applies to every stimulating launch.` });
  for (const o of L) if (o.after > 75 && o.before <= 75) {
    const n = a.nudges.find((x) => Math.abs(x.t - o.t) < 5000);
    const follow = n ? (n.outcome === "open" ? " A frayed nudge fired and is still open." : ` A frayed nudge fired: ${n.outcome}${n.responseMin != null ? ` after ${n.responseMin} min` : ""}.`) : "";
    m.push({ t: o.t, text: `${o.app} (${o.mode === "default" ? o.label : o.mode}) took the level to ${o.after} (frayed).${follow}` });
  }
  for (const s of a.sessions) {
    if (s.weight < 0 && s.minutes >= 8 && s.levelStart - s.levelEnd >= 3) m.push({ t: s.start, text: `${s.app} for ~${Math.round(s.minutes)} min. Level ${s.levelStart} → ${s.levelEnd}.` });
    if (s.weight > 0 && s.minutes >= 15) m.push({ t: s.start, text: `${s.app} for ${s.endedBy === "default" ? `${Math.round(s.minutes)} min (assumed: the real end wasn't seen)` : `~${Math.round(s.minutes)} min`}, ${signed(s.points)} for the time.` });
  }
  for (const f of a.feels) if (Math.abs(f.gap) >= 30) m.push({ t: f.t, text: `Check-in: felt ${f.felt} vs tracker ${f.computed} (${f.gap > 0 ? "tracker too low" : "tracker too high"}).` });
  return m.sort((x, y) => x.t - y.t);
}

function loggingProblems(a, d) {
  const p = [];
  if (d.dupNudgeRows) p.push(`${d.dupNudgeRows} nudge row(s) were logged twice (counted once here).`);
  if (d.identical.length) p.push(`${d.identical.length} row(s) were posted twice, identically (counted once here): ${d.identical.map((r) => `${r.event}${r.nudge_reason ? ` (${r.nudge_reason.replace(/_/g, " ")})` : r.app ? ` (${r.app})` : ""} at ${fmtT(r.t)}`).join(", ")}.`);
  if (d.dupSessions.length) p.push(`${d.dupSessions.length} session end(s) were written twice: ${[...new Set(d.dupSessions.map((r) => r.app))].join(", ")} (the first close is kept).`);
  const lastOpen = a.launches[a.launches.length - 1];
  const missing = a.launches.filter((o) => !o.session && o.activity !== "going_to_sleep" && o.activity !== "back_to_work"
    && !(a.summary.inProgress && o === lastOpen));
  if (missing.length) {
    const by = {};
    for (const o of missing) by[o.app] = (by[o.app] || 0) + 1;
    p.push(`${missing.length} launch(es) have no session end, so their time is unknown: ${Object.entries(by).map(([k, v]) => `${k}${v > 1 ? ` ×${v}` : ""}`).join(", ")}.`);
  }
  if (!p.length) p.push("None found.");
  return p;
}

function takeaways(a, cmp) {
  const t = [], s = a.summary, H = a.byHour;
  // spikes: runs of hours with 15+ net points
  const wins = [];
  for (let i = 0; i < 24; i++) if (H[i].net >= 15) {
    const w = wins[wins.length - 1];
    if (w && w.to === i - 1) { w.to = i; w.net += H[i].net; } else wins.push({ from: i, to: i, net: H[i].net });
  }
  wins.sort((x, y) => y.net - x.net);
  if (wins.length && s.net > 0) {
    const top = wins.slice(0, 2), share = Math.round((100 * sum(top, (w) => w.net)) / s.net);
    const name = (w) => (w.from === w.to ? fmtT(H[w.from].t) : `${fmtT(H[w.from].t)}–${fmtT(H[w.to].t + HOUR)}`);
    t.push(`${top.length > 1 ? "Two spikes" : "One spike"}: ${top.map((w) => `${name(w)} (${signed(w.net)})`).join(" and ")}, ${share}% of the day's ${s.net} net points.`);
  }
  // the longest stretch at or under 50
  let best = null, runStart = null;
  for (let x = s.firstUse; x <= s.lastUse; x += MIN) {
    const l = levelAt(a.curve, x);
    if (l != null && l <= 50) { if (runStart == null) runStart = x; if (!best || x - runStart > best[1] - best[0]) best = [runStart, x]; }
    else runStart = null;
  }
  if (best && best[1] - best[0] >= 2 * HOUR) t.push(`Calm stretch: from ${fmtT(best[0])} to ${fmtT(best[1])} the level stayed at or under 50.`);
  if (s.glance > 0 && s.added > 0) t.push(`${s.glance} points (${Math.round((100 * s.glance) / s.added)}% of those added) came back as glance refunds: many launches were quick looks of under 10 seconds.`);
  const late = a.launches.filter((o) => lateNight(o.t) && o.t > a.start + 12 * HOUR && o.activity !== "back_to_work");
  const lateNet = sum(late, (o) => o.points);
  if (lateNet > 0 && s.net > 0) t.push(`${r1(lateNet)} points (${Math.round((100 * lateNet) / s.net)}%) came after 10 PM, where each stimulating launch counts 1.5×.`);
  if (s.peak && s.peak.app) t.push(`Peak ${s.peak.level} at ${fmtT(s.peak.t)} came from ${s.peak.app}${s.peak.mode && s.peak.mode !== "default" ? ` (${s.peak.mode})` : ""}${s.peak.afterRefund != null ? `; ${s.peak.afterRefund} after its glance refund` : ""}.`);
  if (s.nudges) t.push(`Nudges: ${s.nudgesFollowed} of ${s.nudges} followed${s.nudgesOpen ? `, ${s.nudgesOpen} still open` : ""}.`);
  if (!s.checkins) t.push("No check-ins today, so the tracker is uncalibrated for this day.");
  else {
    const hi = a.feels.reduce((p, f) => (!p || f.gap < p.gap ? f : p), null), lo = a.feels.reduce((p, f) => (!p || f.gap > p.gap ? f : p), null);
    t.push(`${s.checkins} check-in(s), mean gap ${s.checkinGap} points. Biggest misses: tracker too high at ${fmtT(hi.t)} (${hi.computed} vs felt ${hi.felt}), too low at ${fmtT(lo.t)} (${lo.computed} vs felt ${lo.felt}).`);
  }
  const frayedTimes = a.launches.filter((o) => o.after > 75).map((o) => o.t);
  if (frayedTimes.length && !frayedTimes.some((ft) => a.feels.some((f) => f.t >= ft && f.t - ft < 30 * MIN)))
    t.push("No check-in within 30 min of any frayed reading, so the frayed level is unconfirmed.");
  const missing = a.dims.filter((d) => !d.done).map((d) => d.name);
  t.push(`${s.dimsDone} of 4 dimensions done${missing.length ? ` (missing: ${missing.join(", ")})` : ""}.`);
  if (cmp && cmp.summary) {
    const c = cmp.summary;
    t.push(`Compared with ${cmp.name}: points ${s.net} vs ${r1(c.net)}, launches ${s.launches} vs ${r1(c.launches)}, peak ${s.peak ? s.peak.level : "–"} vs ${c.peakLevel != null ? r1(c.peakLevel) : "–"}, frayed launches ${s.bands.frayed} vs ${r1(c.frayed)}.`);
  }
  return t;
}

// ---------- comparison targets (computed live from events) ----------
const numbers = (a) => ({ launches: a.summary.launches, net: a.summary.net, added: a.summary.added, removed: a.summary.removed,
  glance: a.summary.glance, effective: a.summary.effective, peakLevel: a.summary.peak ? a.summary.peak.level : null,
  timeInApps: a.summary.timeInApps, frayed: a.summary.bands.frayed, idleBreaks: a.summary.idleBreaks,
  manualBreaks: a.summary.manualBreaks, checkins: a.summary.checkins, dimsDone: a.summary.dimsDone,
  frayedMin: a.bandMinutes.frayed, loadedMin: a.bandMinutes.loaded, steadyMin: a.bandMinutes.steady, calmMin: a.bandMinutes.calm });
const analyzedCache = new Map();
function analysisFor(day) {
  if (!analyzedCache.has(day)) analyzedCache.set(day, analyze(DAYS.get(day) || [], day));
  return analyzedCache.get(day);
}
function priorDays(day, n = 7) {
  return [...DAYS.keys()].filter((k) => k < day && DAYS.get(k).length >= 3).sort().slice(-n);
}
function compareTarget(sel, day) {
  if (!sel || sel === "none") return null;
  if (sel === "mean" || sel === "median") {
    const days = priorDays(day);
    if (!days.length) return null;
    const as = days.map(analysisFor), f = sel === "mean" ? mean : median;
    const keys = Object.keys(numbers(as[0])), summary = {};
    for (const k of keys) summary[k] = f(as.map((x) => numbers(x)[k]).filter((v) => v != null));
    const curve = [];
    for (let off = 0; off <= DAY; off += 10 * MIN) {
      const vals = as.map((x) => levelAt(x.curve, x.start + off)).filter((v) => v != null);
      if (vals.length) curve.push([off, f(vals)]);
    }
    const hours = Array.from({ length: 24 }, (_, i) => f(as.map((x) => x.byHour[i].net)));
    return { name: `the ${sel} of ${days.length} earlier day${days.length > 1 ? "s" : ""}`, short: sel === "mean" ? "Average" : "Median", summary, curveOffsets: curve, hours };
  }
  const a = analysisFor(sel);
  return { name: fmtDay(sel), short: fmtDay(sel), summary: numbers(a), curveOffsets: a.curve.map(([t, v]) => [t - a.start, v]), hours: a.byHour.map((h) => h.net) };
}

// ---------- tooltip ----------
const tip = () => $("tip");
function showTip(evt, build) {
  const t = tip(); t.replaceChildren(); build(t); t.hidden = false;
  const x = evt.clientX, y = evt.clientY, w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = Math.max(6, Math.min(innerWidth - w - 6, x + 14)) + "px";
  t.style.top = Math.max(6, y - h - 12 < 6 ? y + 16 : y - h - 12) + "px";
}
const hideTip = () => { tip().hidden = true; };
function tipLine(parent, value, label, color) {
  const d = el("div");
  if (color) { const k = el("span", { class: "key" }); k.style.background = color; d.append(k, " "); }
  d.append(el("span", { class: "big" }, value), " ", el("span", { class: "t" }, label));
  parent.append(d);
}

// ---------- render ----------
function bandColor(b) { return `var(--${b})`; }
function markerPath(kind, x, y, r = 5) {
  if (kind > 0) return `M${x},${y - r} L${x + r},${y + r * 0.8} L${x - r},${y + r * 0.8} Z`; // up: stimulating
  if (kind < 0) return `M${x},${y + r} L${x + r},${y - r * 0.8} L${x - r},${y - r * 0.8} Z`; // down: calming
  return `M${x},${y - r} L${x + r},${y} L${x},${y + r} L${x - r},${y} Z`; // diamond: neutral / log
}
const kindColor = (w) => (w > 0 ? "var(--added)" : w < 0 ? "var(--removed)" : "var(--neutral)");

function renderTiles(a, cmp) {
  const s = a.summary, c = cmp && cmp.summary, box = $("tiles");
  box.replaceChildren();
  const tile = (k, v, d, cv, fmt = (x) => r1(x)) => {
    const t = el("div", { class: "tile" });
    t.append(el("div", { class: "k" }, k), el("div", { class: "v" }, v));
    if (d) t.append(el("div", { class: "d" }, d));
    if (cv != null && c) t.append(el("div", { class: "d" }, `${cmp.short}: ${fmt(cv)}`));
    box.append(t);
  };
  tile("Launches", s.launches, s.backToWork ? `+${s.backToWork} Back to work (not counted)` : "", c && c.launches);
  tile("Net launch points", s.net, `${s.added} added · ${Math.abs(s.removed)} removed`, c && c.net);
  tile("After glance refunds", s.effective, `${s.glance} refunded`, c && c.effective);
  tile("Peak level", s.peak ? s.peak.level : "–", s.peak ? `${fmtT(s.peak.t)} · ${bandOf(s.peak.level)}` : "", c && c.peakLevel);
  tile("Time in apps", fmtMin(s.timeInApps), "", c && c.timeInApps, fmtMin);
  tile("Frayed launches", s.bands.frayed, `${s.bands.loaded} loaded · ${s.bands.steady} steady · ${s.bands.calm} calm`, c && c.frayed);
  tile("Idle breaks", s.idleBreaks, `${s.idleCapped} hit the 30-min cap · ${s.manualBreaks} manual`, c && c.idleBreaks);
  tile("Check-ins", s.checkins, s.checkinGap != null ? `mean gap ${s.checkinGap} points` : "none today", c && c.checkins);
  tile("Nudges followed", `${s.nudgesFollowed}/${s.nudges}`, s.nudgesOpen ? `${s.nudgesOpen} still open` : "");
  tile("Dimensions", `${s.dimsDone}/4`, "", c && c.dimsDone);
}

function renderTimeline(a, cmp) {
  const wrap = $("tlWrap"), full = $("fullDay").checked;
  wrap.replaceChildren();
  const x0 = full ? a.start : Math.max(a.start, a.summary.firstUse - 15 * MIN);
  const x1 = full ? a.end : Math.min(a.end, Math.max(a.summary.lastUse + 15 * MIN, x0 + 2 * HOUR));
  const hours = (x1 - x0) / HOUR;
  const W = Math.max(wrap.clientWidth || 340, Math.round(hours * 45)), M = { l: 30, r: 58, t: 8, b: 22 };
  const PH = 230, LANE = 14, H = M.t + PH + 8 + LANE * 2 + 10 + M.b;
  const X = (t) => M.l + ((t - x0) / (x1 - x0)) * (W - M.l - M.r), Y = (v) => M.t + PH - (v / 100) * PH;
  const svg = sv("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Overstimulation level over the day" });
  const defs = sv("defs"); svg.append(defs);
  // late-night shading
  for (let d = a.start - DAY; d < a.end + DAY; d += DAY) {
    const s0 = new Date(d); s0.setHours(LATE_START, 0, 0, 0); const n0 = s0.getTime(), n1 = n0 + (24 - LATE_START + LATE_END) * HOUR;
    const lo = Math.max(n0, x0), hi = Math.min(n1, x1);
    if (hi > lo) svg.append(sv("rect", { x: X(lo), y: M.t, width: X(hi) - X(lo), height: PH, fill: "var(--night)" }));
  }
  // band guides (solid hairlines) and labels on the right
  for (const [v, name] of [[0, null], [25, "calm"], [50, "steady"], [75, "loaded"], [100, "frayed"]]) {
    svg.append(sv("line", { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), stroke: v ? "var(--grid)" : "var(--axis)", "stroke-width": 1 }));
    svg.append(sv("text", { x: M.l - 6, y: Y(v) + 4, "text-anchor": "end" }, String(v)));
  }
  BANDS.forEach(([hi], i) => {
    const lo = i ? BANDS[i - 1][0] : 0, name = BANDS[i][1];
    svg.append(sv("rect", { x: W - M.r + 6, y: Y(hi) + 2, width: 4, height: Y(lo) - Y(hi) - 4, rx: 2, fill: bandColor(name) }));
    svg.append(sv("text", { x: W - M.r + 14, y: (Y(hi) + Y(lo)) / 2 + 4, class: "lbl" }, name));
  });
  // hour ticks
  for (let t = Math.ceil(x0 / HOUR) * HOUR; t <= x1; t += HOUR) {
    const step = hours > 14 ? 2 : 1;
    if (new Date(t).getHours() % step) continue;
    svg.append(sv("text", { x: X(t), y: H - 6, "text-anchor": "middle" }, new Date(t).toLocaleTimeString([], { hour: "numeric" })));
    svg.append(sv("line", { x1: X(t), x2: X(t), y1: M.t + PH, y2: M.t + PH + 4, stroke: "var(--axis)" }));
  }
  // the level: area colored by band (one copy per band, clipped to its strip), then a thin line
  const pts = a.curve.filter(([t]) => t >= x0 - HOUR && t <= x1 + HOUR);
  if (pts.length) {
    const line = pts.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    const area = `${line} L${X(pts[pts.length - 1][0]).toFixed(1)},${Y(0)} L${X(pts[0][0]).toFixed(1)},${Y(0)} Z`;
    const plot = sv("clipPath", { id: "plotClip" }); plot.append(sv("rect", { x: M.l, y: M.t, width: W - M.l - M.r, height: PH })); defs.append(plot);
    BANDS.forEach(([hi], i) => {
      const lo = i ? BANDS[i - 1][0] : 0, id = `band${i}`;
      const cp = sv("clipPath", { id }); cp.append(sv("rect", { x: M.l, y: Y(hi), width: W - M.l - M.r, height: Y(lo) - Y(hi) + (i ? 0 : 1) })); defs.append(cp);
      const g = sv("g", { "clip-path": "url(#plotClip)" });
      g.append(sv("path", { d: area, fill: bandColor(BANDS[i][1]), "fill-opacity": 0.42, "clip-path": `url(#${id})` }));
      svg.append(g);
    });
    const g = sv("g", { "clip-path": "url(#plotClip)" });
    g.append(sv("path", { d: line, fill: "none", stroke: "var(--ink)", "stroke-width": 1.6, "stroke-linejoin": "round" }));
    svg.append(g);
  }
  // comparison curve, aligned by clock time from 4 AM
  let cmpPts = null;
  if (cmp && cmp.curveOffsets && cmp.curveOffsets.length) {
    cmpPts = cmp.curveOffsets.map(([off, v]) => [a.start + off, v]).filter(([t]) => t >= x0 && t <= x1);
    if (cmpPts.length > 1) svg.append(sv("path", { d: cmpPts.map(([t, v], i) => `${i ? "L" : "M"}${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(" "),
      fill: "none", stroke: "var(--ink-2)", "stroke-width": 1.5, "stroke-dasharray": "5 4", opacity: 0.85 }));
  }
  // launch markers, including weight-0 logs (diamonds)
  for (const o of a.launches) if (o.t >= x0 && o.t <= x1 && o.after != null)
    svg.append(sv("path", { d: markerPath(o.weight, X(o.t), Y(o.after)), fill: kindColor(o.weight), stroke: "var(--surface)", "stroke-width": 2 }));
  // lanes: sessions and rests
  const laneY = M.t + PH + 8;
  svg.append(sv("text", { x: M.l - 4, y: laneY + 10, "text-anchor": "end" }, "app"));
  svg.append(sv("text", { x: M.l - 4, y: laneY + LANE + 12, "text-anchor": "end" }, "rest"));
  for (const s of a.sessions) {
    if (s.end < x0 || s.start > x1) continue;
    svg.append(sv("rect", { x: X(Math.max(s.start, x0)), y: laneY, width: Math.max(2, X(Math.min(s.end, x1)) - X(Math.max(s.start, x0))),
      height: LANE - 3, rx: 2, fill: kindColor(s.weight), "fill-opacity": 0.85 }));
  }
  for (const r of a.rests) {
    const r0 = r.t - r.minutes * MIN, rc = r0 + (r.credited != null ? r.credited : r.minutes) * MIN;
    if (r.t < x0 || r0 > x1) continue;
    const y = laneY + LANE + 1, xa = X(Math.max(r0, x0));
    svg.append(sv("rect", { x: xa, y, width: Math.max(2, X(Math.min(r.t, x1)) - xa), height: LANE - 3, rx: 2, fill: "var(--calm)", "fill-opacity": 0.25 }));
    svg.append(sv("rect", { x: xa, y, width: Math.max(2, X(Math.min(rc, x1)) - xa), height: LANE - 3, rx: 2, fill: "var(--calm)", "fill-opacity": 0.8 }));
  }
  // hover layer: crosshair + one tooltip
  const cross = sv("line", { y1: M.t, y2: laneY + LANE * 2, stroke: "var(--ink-2)", "stroke-width": 1, visibility: "hidden" });
  svg.append(cross);
  const hit = sv("rect", { x: M.l, y: M.t, width: W - M.l - M.r, height: laneY + LANE * 2 - M.t, fill: "transparent" });
  svg.append(hit);
  const onMove = (e) => {
    const r = svg.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const t = x0 + ((px - M.l) / (W - M.l - M.r)) * (x1 - x0);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
    const near = a.launches.filter((o) => Math.abs(X(o.t) - px) <= 12);
    const inLanes = py > laneY - 2;
    showTip(e, (box) => {
      box.append(el("div", { class: "t" }, fmtT(t)));
      const lv = levelAt(a.curve, t);
      if (lv != null) tipLine(box, `${Math.round(lv)}`, `level · ${bandOf(lv)}`, "var(--ink)");
      if (cmpPts) { const cv = levelAt(cmpPts, t); if (cv != null) tipLine(box, `${Math.round(cv)}`, `level · ${cmp.short}`, "var(--ink-2)"); }
      if (inLanes) {
        const s = a.sessions.find((x) => t >= x.start - MIN && t <= x.end + MIN);
        if (s) { const d = el("div", { class: "ln" }); d.append(el("div", { class: "big" }, `${s.app} · ${fmtMin(s.minutes)}`), el("div", { class: "t" }, `${fmtT(s.start)}–${fmtT(s.end)} · ended by ${s.endedBy}${s.refund ? ` · glance refund ${s.refund}` : ""}`)); box.append(d); }
        const rr = a.rests.find((x) => t >= x.t - x.minutes * MIN && t <= x.t);
        if (rr) { const d = el("div", { class: "ln" }); d.append(el("div", { class: "big" }, `${rr.kind === "auto_break" ? "Idle break" : rr.kind === "wake" ? "Sleep" : "Break"} · ${fmtMin(rr.minutes)}`), el("div", { class: "t" }, `${rr.credited != null ? `${fmtMin(rr.credited)} credited${rr.capped ? " (capped)" : ""} · ` : ""}level ${rr.before} → ${rr.after}`)); box.append(d); }
      }
      for (const o of near.slice(0, 6)) {
        const d = el("div", { class: "ln" });
        d.append(el("div", { class: "big" }, `${o.app} · ${o.mode === "default" ? "default" : `mode ${o.mode}`}`));
        d.append(el("div", { class: "t" }, `${fmtT(o.t)} · ${o.label}`));
        d.append(el("div", {}, `${signed(o.points)} points (weight ${o.weight}) · level ${o.before} → ${o.after}${o.sw ? ` · switching +${o.sw}` : ""}${o.ck ? ` · checking loop +${o.ck}` : ""}`));
        if (o.session) d.append(el("div", { class: "t" }, `in app ${fmtMin(o.session.minutes)} (${o.session.endedBy})${o.session.refund ? ` · glance refund ${o.session.refund}` : ""}`));
        box.append(d);
      }
      if (near.length > 6) box.append(el("div", { class: "t" }, `+${near.length - 6} more launches here`));
    });
  };
  hit.addEventListener("pointermove", onMove); hit.addEventListener("pointerdown", onMove);
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTip(); });
  wrap.append(svg);
  // legend
  const lg = $("tlLegend"); lg.replaceChildren();
  for (const b of BAND_NAMES) { const c = el("span", { class: "chip" }); const sw = el("span", { class: "sw" }); sw.style.background = bandColor(b); c.append(sw, b); lg.append(c); }
  const mk = (w, txt) => { const c = el("span", { class: "chip" }); const s = sv("svg", { width: 12, height: 12 }); s.append(sv("path", { d: markerPath(w, 6, 6, 5), fill: kindColor(w) })); c.append(s, txt); lg.append(c); };
  mk(1, "stimulating launch"); mk(-1, "calming"); mk(0, "neutral / log");
  if (cmpPts) { const c = el("span", { class: "chip" }); const k = el("span", { class: "key" }); k.style.borderTop = "2px dashed var(--ink-2)"; k.style.height = "0"; c.append(k, cmp.short); lg.append(c); }
  const n = el("span", { class: "chip" }); const ns = el("span", { class: "sw" }); ns.style.background = "var(--night)"; ns.style.outline = "1px solid var(--ring)"; n.append(ns, "late night ×1.5"); lg.append(n);
  // table view of every launch
  const tb = el("table"); const hd = el("tr");
  for (const h of ["Time", "App", "Mode", "Points", "Level", "In app"]) hd.append(el("th", h === "Points" || h === "Level" ? { class: "n" } : {}, h));
  tb.append(hd);
  for (const o of a.launches) {
    const tr = el("tr");
    tr.append(el("td", {}, fmtT(o.t)), el("td", {}, o.app), el("td", {}, o.mode === "default" ? o.label : `${o.mode} · ${o.label}`),
      el("td", { class: "n" }, signed(o.points)), el("td", { class: "n" }, `${o.before} → ${o.after}`), el("td", {}, o.session ? fmtMin(o.session.minutes) : "–"));
    tb.append(tr);
  }
  $("launchTable").replaceChildren(tb);
}

function renderBandBars(a, cmp) {
  const box = $("bandBars"); box.replaceChildren();
  const rowsData = [{ name: "This day", m: a.bandMinutes }];
  if (cmp && cmp.summary) rowsData.push({ name: cmp.short, m: { calm: cmp.summary.calmMin, steady: cmp.summary.steadyMin, loaded: cmp.summary.loadedMin, frayed: cmp.summary.frayedMin } });
  for (const r of rowsData) {
    const total = sum(BAND_NAMES, (b) => r.m[b] || 0) || 1;
    box.append(el("div", { class: "muted" }, `${r.name} · ${fmtMin(total)} between first and last use`));
    const bar = el("div"); bar.style.cssText = "display:flex;gap:2px;height:22px;margin:4px 0 10px";
    for (const b of BAND_NAMES) {
      const v = r.m[b] || 0; if (!v) continue;
      const seg = el("div", { tabindex: "0" }); seg.style.cssText = `flex:${v};background:${bandColor(b)};border-radius:4px;min-width:3px`;
      const tipFor = (e) => showTip(e, (t) => { t.append(el("div", { class: "t" }, r.name)); tipLine(t, fmtMin(v), `${b} · ${Math.round((100 * v) / total)}%`, bandColor(b)); });
      seg.addEventListener("pointermove", tipFor); seg.addEventListener("pointerleave", hideTip);
      bar.append(seg);
    }
    box.append(bar);
  }
  const tb = el("table"), hd = el("tr"); hd.append(el("th", {}, "Band"));
  for (const r of rowsData) hd.append(el("th", { class: "n" }, r.name));
  tb.append(hd);
  for (const b of BAND_NAMES) {
    const tr = el("tr"); const td = el("td"); const sw = el("span", { class: "sw" }); sw.style.background = bandColor(b); td.append(sw, " ", b); tr.append(td);
    for (const r of rowsData) tr.append(el("td", { class: "n" }, fmtMin(r.m[b] || 0)));
    tb.append(tr);
  }
  box.append(tb);
}

function renderHours(a, cmp) {
  const box = $("hourChart"); box.replaceChildren();
  const H = a.byHour, W = Math.max(box.clientWidth || 340, 24 * 30), M = { l: 34, r: 8, t: 10, b: 22 }, PH = 170, Ht = M.t + PH + M.b;
  const maxUp = Math.max(10, ...H.map((h) => h.added), ...(cmp && cmp.hours ? cmp.hours.map((v) => Math.max(0, v || 0)) : []));
  const maxDn = Math.max(5, ...H.map((h) => -h.removed), ...(cmp && cmp.hours ? cmp.hours.map((v) => Math.max(0, -(v || 0))) : []));
  const Y = (v) => M.t + (maxUp / (maxUp + maxDn)) * PH - (v / (maxUp + maxDn)) * PH;
  const bw = (W - M.l - M.r) / 24, svg = sv("svg", { width: W, height: Ht, viewBox: `0 0 ${W} ${Ht}`, role: "img", "aria-label": "Launch points by hour" });
  for (const v of [maxUp, Math.round(maxUp / 2), 0, -maxDn]) {
    svg.append(sv("line", { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), stroke: v ? "var(--grid)" : "var(--axis)" }));
    svg.append(sv("text", { x: M.l - 5, y: Y(v) + 4, "text-anchor": "end" }, String(Math.round(v))));
  }
  H.forEach((h, i) => {
    const x = M.l + i * bw + 2, w = Math.max(2, bw - 4);
    if (h.added) svg.append(sv("path", { d: roundTop(x, Y(h.added), w, Y(0) - Y(h.added)), fill: "var(--added)" }));
    if (h.removed) svg.append(sv("path", { d: roundBottom(x, Y(0), w, Y(h.removed) - Y(0)), fill: "var(--removed)" }));
    if (cmp && cmp.hours && cmp.hours[i]) svg.append(sv("line", { x1: x - 1, x2: x + w + 1, y1: Y(cmp.hours[i]), y2: Y(cmp.hours[i]), stroke: "var(--ink-2)", "stroke-width": 2 }));
    if (i % 2 === 0) svg.append(sv("text", { x: x + w / 2, y: Ht - 6, "text-anchor": "middle" }, new Date(h.t).toLocaleTimeString([], { hour: "numeric" })));
    const hitR = sv("rect", { x: M.l + i * bw, y: M.t, width: bw, height: PH, fill: "transparent", tabindex: "0" });
    const tipFor = (e) => showTip(e, (t) => {
      t.append(el("div", { class: "t" }, `${fmtT(h.t)}–${fmtT(h.t + HOUR)}`));
      tipLine(t, signed(h.net), "net points", "var(--ink)");
      if (h.added) tipLine(t, signed(h.added), "added", "var(--added)");
      if (h.removed) tipLine(t, signed(h.removed), "removed", "var(--removed)");
      if (cmp && cmp.hours) tipLine(t, signed(cmp.hours[i] || 0), `net · ${cmp.short}`, "var(--ink-2)");
      t.append(el("div", { class: "t" }, `${h.launches} launches · peak ${h.peak ?? "–"} · ${fmtMin(h.minutes)} in apps`));
    });
    hitR.addEventListener("pointermove", tipFor); hitR.addEventListener("pointerdown", tipFor); hitR.addEventListener("pointerleave", hideTip);
    svg.append(hitR);
  });
  box.append(svg);
  const tb = el("table"), hd = el("tr");
  for (const h of ["Hour", "Launches", "Net", "Peak", "In apps"].concat(cmp && cmp.hours ? [`Net · ${cmp.short}`] : [])) hd.append(el("th", h === "Hour" ? {} : { class: "n" }, h));
  tb.append(hd);
  H.forEach((h, i) => {
    if (!h.launches && !h.minutes && h.peak == null && !(cmp && cmp.hours && cmp.hours[i])) return;
    const tr = el("tr");
    tr.append(el("td", {}, fmtT(h.t)), el("td", { class: "n" }, String(h.launches)), el("td", { class: "n" }, signed(h.net)),
      el("td", { class: "n" }, h.peak == null ? "–" : String(h.peak)), el("td", { class: "n" }, h.minutes ? fmtMin(h.minutes) : "–"));
    if (cmp && cmp.hours) tr.append(el("td", { class: "n" }, signed(cmp.hours[i] || 0)));
    tb.append(tr);
  });
  $("hourTable").replaceChildren(tb);
  const lg = $("hourLegend"); lg.replaceChildren();
  for (const [c, txt] of [["var(--added)", "points added"], ["var(--removed)", "points removed (calming)"]]) { const ch = el("span", { class: "chip" }); const s = el("span", { class: "sw" }); s.style.background = c; ch.append(s, txt); lg.append(ch); }
  if (cmp && cmp.hours) { const ch = el("span", { class: "chip" }); const k = el("span", { class: "key" }); k.style.background = "var(--ink-2)"; ch.append(k, `net · ${cmp.short}`); lg.append(ch); }
}
function roundTop(x, y, w, h) { const r = Math.min(4, w / 2, h); return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`; }
function roundBottom(x, y, w, h) { const r = Math.min(4, w / 2, h); return `M${x},${y} L${x + w},${y} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x + r},${y + h} Q${x},${y + h} ${x},${y + h - r} Z`; }

function renderApps(a) {
  const box = $("apps"); box.replaceChildren();
  const max = Math.max(1, ...a.byApp.map((x) => Math.abs(x.net)));
  const tb = el("table"), hd = el("tr");
  for (const h of ["App", "", "Net", "Launches", "Time"]) hd.append(el("th", h === "App" || h === "" ? {} : { class: "n" }, h));
  tb.append(hd);
  for (const x of a.byApp) {
    const tr = el("tr"), bar = el("div"); const tdBar = el("td"); tdBar.style.width = "40%";
    bar.style.cssText = `height:10px;border-radius:0 4px 4px 0;width:${Math.max(2, (100 * Math.abs(x.net)) / max)}%;background:${x.net > 0 ? "var(--added)" : x.net < 0 ? "var(--removed)" : "var(--neutral)"}`;
    tdBar.append(bar);
    tr.append(el("td", {}, x.app), tdBar, el("td", { class: "n" }, signed(x.net)), el("td", { class: "n" }, String(x.launches)),
      el("td", { class: "n" }, x.minutes ? fmtMin(x.minutes) : x.noSession ? "not logged" : "~0"));
    tb.append(tr);
  }
  box.append(tb);
}

function renderFeels(a) {
  const box = $("feels"); box.replaceChildren();
  if (!a.feels.length) { box.append(el("div", { class: "muted" }, "No check-ins this day.")); return; }
  const S = 220, M = 28, svg = sv("svg", { width: S + M + 10, height: S + M + 10, role: "img", "aria-label": "Check-ins: tracker against felt" });
  const X = (v) => M + (v / 100) * S, Y = (v) => S - (v / 100) * S + 6;
  for (const v of [0, 25, 50, 75, 100]) {
    svg.append(sv("line", { x1: X(0), x2: X(100), y1: Y(v), y2: Y(v), stroke: v ? "var(--grid)" : "var(--axis)" }));
    svg.append(sv("text", { x: M - 5, y: Y(v) + 4, "text-anchor": "end" }, String(v)));
    svg.append(sv("text", { x: X(v), y: S + 22, "text-anchor": "middle" }, String(v)));
  }
  svg.append(sv("line", { x1: X(0), y1: Y(0), x2: X(100), y2: Y(100), stroke: "var(--axis)" }));
  svg.append(sv("text", { x: X(100), y: S + 34, "text-anchor": "end" }, "tracker →"));
  svg.append(sv("text", { x: X(0) + 4, y: Y(100) + 10 }, "felt ↑"));
  for (const f of a.feels) {
    svg.append(sv("circle", { cx: X(f.computed), cy: Y(f.felt), r: 5, fill: "var(--ink)", stroke: "var(--surface)", "stroke-width": 2 }));
    const hitC = sv("circle", { cx: X(f.computed), cy: Y(f.felt), r: 12, fill: "transparent", tabindex: "0" });
    const tipFor = (e) => showTip(e, (t) => { t.append(el("div", { class: "t" }, `${fmtT(f.t)} · ${f.source}`)); tipLine(t, String(f.felt), "felt"); tipLine(t, String(f.computed), "tracker"); tipLine(t, signed(f.gap, 0), "gap"); });
    hitC.addEventListener("pointermove", tipFor); hitC.addEventListener("pointerdown", tipFor); hitC.addEventListener("pointerleave", hideTip);
    svg.append(hitC);
  }
  box.append(svg, el("div", { class: "muted" }, "Dots above the line: you felt more than the tracker said; below: less."));
  const tb = el("table"), hd = el("tr");
  for (const h of ["Time", "Felt", "Tracker", "Gap", "Source"]) hd.append(el("th", h === "Time" || h === "Source" ? {} : { class: "n" }, h));
  tb.append(hd);
  for (const f of a.feels) { const tr = el("tr"); tr.append(el("td", {}, fmtT(f.t)), el("td", { class: "n" }, String(f.felt)), el("td", { class: "n" }, String(f.computed)), el("td", { class: "n" }, signed(f.gap, 0)), el("td", {}, f.source)); tb.append(tr); }
  box.append(tb);
}

function renderDims(a, day) {
  const box = $("dims"); box.replaceChildren();
  for (const d of a.dims) {
    const row = el("div", { class: "check" });
    row.append(el("span", { class: "box" + (d.done ? " on" : ""), "aria-label": d.done ? "done" : "not done" }, d.done ? "✓" : ""));
    const txt = el("div"); txt.append(el("div", { class: "big" }, `${d.name} dimension${d.done ? " done" : ""}`),
      el("div", { class: "muted" }, `${d.what}${d.need > 1 ? ` · ${d.count} of ${d.need}` : d.count ? ` · ${d.count}×` : ""}`));
    row.append(txt); box.append(row);
  }
  // last 7 days grid
  const days = [...DAYS.keys()].filter((k) => k <= day).sort().slice(-7);
  const g = el("div", { class: "grid7" });
  g.append(el("div"));
  for (const k of days) g.append(el("div", { class: "muted", style: "text-align:center" }, new Date(dayStartOf(k)).toLocaleDateString([], { weekday: "narrow" })));
  for (const d of DIMENSIONS) {
    g.append(el("div", { class: "muted" }, d.name));
    for (const k of days) { const done = analysisFor(k).dims.find((x) => x.key === d.key).done; g.append(el("div", { class: "c" + (done ? " on" : ""), title: `${fmtDay(k)}: ${done ? "done" : "not done"}` }, done ? "✓" : "")); }
  }
  $("dims7").replaceChildren(g);
}

function renderNudges(a) {
  const box = $("nudges"); box.replaceChildren();
  if (!a.nudges.length) { box.append(el("div", { class: "muted" }, "No nudges this day.")); return; }
  const tb = el("table"), hd = el("tr");
  for (const h of ["Time", "Reason", "Outcome"]) hd.append(el("th", {}, h));
  tb.append(hd);
  for (const n of a.nudges) {
    const tr = el("tr"), oc = el("td"), followed = ["break", "calming", "roulette"].includes(n.outcome);
    oc.append(el("span", { class: "chip" }, `${followed ? "✓ followed: " : ""}${n.outcome}${n.responseMin != null ? ` · ${n.responseMin} min` : ""}`));
    tr.append(el("td", {}, fmtT(n.t)), el("td", {}, n.reason.replace(/_/g, " ")), oc); tb.append(tr);
  }
  box.append(tb);
}

function renderCompare(a, cmp) {
  const box = $("compareTable"); box.replaceChildren();
  if (!cmp) { box.append(el("div", { class: "muted" }, "Pick a day, the average or the median in \"Compare with\" to see differences here.")); return; }
  const s = numbers(a), c = cmp.summary;
  const rows = [["Launches", "launches"], ["Net launch points", "net"], ["Points added", "added"], ["Points removed", "removed"], ["Glance refunds", "glance"],
    ["After refunds", "effective"], ["Peak level", "peakLevel"], ["Time in apps (min)", "timeInApps"], ["Frayed launches", "frayed"],
    ["Minutes frayed", "frayedMin"], ["Minutes loaded", "loadedMin"], ["Idle breaks", "idleBreaks"], ["Manual breaks", "manualBreaks"], ["Check-ins", "checkins"], ["Dimensions done", "dimsDone"]];
  const tb = el("table"), hd = el("tr");
  for (const h of ["", fmtDay(a.day), cmp.short, "Difference"]) hd.append(el("th", h ? { class: "n" } : {}, h));
  tb.append(hd);
  for (const [name, k] of rows) {
    const v = s[k], cv = c[k], tr = el("tr");
    tr.append(el("td", {}, name), el("td", { class: "n" }, v == null ? "–" : String(r1(v))), el("td", { class: "n" }, cv == null ? "–" : String(r1(cv))),
      el("td", { class: "n" }, v == null || cv == null ? "–" : signed(v - cv)));
    tb.append(tr);
  }
  box.append(tb);
}

function render(saved) {
  const cmp = compareTarget($("cmp").value, A.day);
  $("report").hidden = false;
  const s = A.summary;
  $("dayline").textContent = `${fmtDay(A.day)} · 4 AM to 4 AM · first use ${fmtT(s.firstUse)}, last ${fmtT(s.lastUse)}${s.inProgress ? " · day still in progress" : ""}${s.wake ? ` · woke ${fmtT(s.wake.t)} after ${fmtMin(s.wake.sleepMinutes)}` : ""}`;
  renderTiles(A, cmp); renderTimeline(A, cmp); renderBandBars(A, cmp); renderDims(A, A.day); renderHours(A, cmp);
  renderApps(A); renderFeels(A); renderNudges(A); renderCompare(A, cmp);
  const mo = $("moments"); mo.replaceChildren();
  for (const m of A.moments) { const li = el("li"); li.append(el("span", { class: "tm" }, fmtT(m.t)), m.text); mo.append(li); }
  if (!A.moments.length) mo.append(el("li", { class: "muted" }, "Nothing stood out."));
  // takeaways are saved with the day; the comparison line follows the current "Compare with" choice
  const tk = $("takeaways"); tk.replaceChildren();
  for (const t of takeaways(A, cmp)) tk.append(el("li", {}, t));
  const pr = $("problems"); pr.replaceChildren();
  for (const p of A.problems) pr.append(el("li", {}, p));
  $("savedNote").textContent = saved ? `Analysis saved ${new Date(saved).toLocaleString()} (computed from ${A.launches.length} launches). "Redo analysis" re-computes it from the latest data and saves over it.` : "";
}

// ---------- page flow ----------
function setStatus(msg, err) { const s = $("status"); s.textContent = msg; s.className = err ? "err" : "muted"; }
function fillDays() {
  const sel = $("day"), keys = [...DAYS.keys()].sort().reverse(), cur = sel.value;
  sel.replaceChildren();
  const today = dayKeyOf(Date.now());
  for (const k of keys) sel.append(el("option", { value: k }, `${fmtDay(k)}${k === today ? " (today)" : ""}${SAVED.has(k) ? " ✓ saved" : ""}`));
  if (cur && keys.includes(cur)) sel.value = cur;
}
function fillCompare() {
  const day = $("day").value, sel = $("cmp"), cur = sel.value;
  sel.replaceChildren(el("option", { value: "none" }, "Nothing"));
  const prior = priorDays(day);
  if (prior.length) {
    sel.append(el("option", { value: prior[prior.length - 1] }, `Previous day (${fmtDay(prior[prior.length - 1])})`));
    sel.append(el("option", { value: "mean" }, `Average of the ${prior.length} days before`), el("option", { value: "median" }, `Median of the ${prior.length} days before`));
  }
  for (const k of [...DAYS.keys()].sort().reverse()) if (k !== day) sel.append(el("option", { value: k }, fmtDay(k)));
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : prior.length ? prior[prior.length - 1] : "none";
}
async function showDay() {
  const day = $("day").value;
  fillCompare();
  $("report").classList.add("stale");
  setStatus("Loading…");
  try {
    const row = await loadSaved(day);
    if (row) {
      A = row.analysis; savedAt = Date.parse(row.created_at);
      render(savedAt);
      $("runBtn").textContent = "Redo analysis";
      setStatus(row.analysis_version !== ANALYSIS_VERSION ? "Saved with an older version of the report: redo it to update." : "");
    } else {
      A = null; savedAt = null; $("report").hidden = true;
      $("runBtn").textContent = "Run analysis";
      setStatus(`Not analysed yet. ${DAYS.get(day).length} events this day. Run the analysis to see and save it.`);
    }
  } catch (e) { setStatus("Couldn't load: " + e.message, true); }
  $("report").classList.remove("stale");
}
async function run() {
  const day = $("day").value, btn = $("runBtn");
  btn.disabled = true; setStatus("Analysing…");
  try {
    await loadEvents(); analyzedCache.clear(); // always the latest data
    A = analyze(DAYS.get(day) || [], day);
    await save(day, A);
    fillDays(); $("day").value = day;
    savedAt = Date.now(); render(savedAt);
    btn.textContent = "Redo analysis";
    setStatus("Analysed and saved.");
  } catch (e) { setStatus(e.message, true); }
  btn.disabled = false;
}
async function init() {
  const q = new URLSearchParams(location.search);
  userId = q.get("u") || (() => { try { return localStorage.getItem("uid"); } catch { return null; } })();
  if (!userId || !C.USER_IDS.includes(userId)) { setStatus("Sign in on the launcher first, then come back here.", true); $("runBtn").disabled = true; return; }
  $("who").textContent = userId;
  setStatus("Loading your data…");
  try {
    const [inv] = await Promise.all([fetch("inventory.json", { cache: "no-cache" }).then((r) => r.json()), loadEvents(), loadSavedList()]);
    INV = inv;
  } catch (e) { setStatus("Couldn't load your data: " + e.message, true); return; }
  if (!DAYS.size) { setStatus("No data in the last 60 days."); return; }
  fillDays();
  const want = q.get("day");
  if (want && DAYS.has(want)) $("day").value = want;
  $("day").onchange = showDay;
  $("cmp").onchange = () => { if (A) render(savedAt); };
  $("fullDay").onchange = () => A && renderTimeline(A, compareTarget($("cmp").value, A.day));
  $("runBtn").onclick = run;
  addEventListener("resize", () => A && renderTimeline(A, compareTarget($("cmp").value, A.day)));
  await showDay();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
