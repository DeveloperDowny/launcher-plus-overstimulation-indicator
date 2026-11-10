"""Launcher + overstimulation tracker. Rule-based, no NLP.

Run:  python launcher.py          (interactive prompt)
      python launcher.py "open instagram reels"   (one-shot)

Commands: open <app> [mode] | show level | take break | feel <0-100> | apps | help | quit
"""
import json
import shutil
import subprocess
import sys
import time
import webbrowser
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Optional

import typer

from inventory import (ACTIVITIES, APPS, DOOMSCROLL_ACTIVITIES, DOOMSCROLL_STREAK, NIGHT_MULT, ROULETTE_CLIPBOARD, ROULETTE_COPY_ACTIVITIES, ROULETTE_DELAY_S,
                       ROULETTE_MORNING_CLIPBOARD, ROULETTE_URL,
                       URL_OVERRIDES)

HERE = Path(__file__).parent
LOG_FILE = HERE / "log.txt"
STATE_FILE = HERE / "state.json"

# --- model knobs -----------------------------------------------------------
POINTS_PER_WEIGHT = 1.5      # one launch adds weight * this to the level
DECAY_PER_MIN = 0.3          # passive recovery per idle minute (slow: HSPs settle slowly)
BREAK_RELIEF = 0.6           # a break removes this fraction of current level
SWITCH_WINDOW_MIN = 5        # >= SWITCH_APPS distinct apps within window -> switching penalty
SWITCH_APPS = 3              # (applied at most once per SWITCH_WINDOW_MIN)
CHECK_REPEATS = 3            # same app this many times within CHECK_WINDOW_MIN -> checking-loop penalty
CHECK_WINDOW_MIN = 10        # (applied at most once per window per app)
BREAK_FULL_MIN = 15          # an inferred break this long gets the full BREAK_RELIEF; shorter ones scale down
AUTO_BREAK_IDLE_MIN = 20     # idle gap before the next command that counts as an (inferred) break
LATE_NIGHT_START = 22        # from 10 PM until LATE_NIGHT_END (local time) stimulating launches hit harder
LATE_NIGHT_END = 5
LATE_NIGHT_MULT = 1.5        # you're likely under-rested and should be heading to sleep

BANDS = [(25, "calm", "Plenty of room. Go ahead."),
         (50, "steady", "Fine, but you're warming up."),
         (75, "loaded", "Getting heavy. A break would help."),
         (100, "frayed", "Overstimulated. Stop adding input; take a break.")]

for _stream in (sys.stdout, sys.stderr):
    _stream.reconfigure(encoding="utf-8")  # block chars for the bar on Windows consoles

app = typer.Typer(add_completion=False)


# --- state & log -----------------------------------------------------------
def now() -> datetime:
    return datetime.now().replace(microsecond=0)


def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    t = now().isoformat()
    return {"level": 0.0, "updated_at": t, "last_break_at": None, "started_at": t, "recent": []}


def save_state(s: dict) -> None:
    STATE_FILE.write_text(json.dumps(s, indent=2))


def mins_since_break(s: dict) -> int:
    """Minutes since last break, or since tracking began if none yet."""
    ref = s["last_break_at"] or s["started_at"]
    return int((now() - datetime.fromisoformat(ref)).total_seconds() // 60)


def log(event: str, s: dict, level_before: float, level_after: float, **extra) -> None:
    """One JSON object per line in log.txt (easy to load with pandas/jq for end-of-day analysis)."""
    t = now()
    rec = {
        "ts": t.isoformat(),
        "date": t.date().isoformat(),
        "hour": t.hour,
        "weekday": t.strftime("%a"),
        "event": event,
        "level_before": round(level_before),
        "band_before": band(level_before)[1],
        "level_after": round(level_after),
        "band_after": band(level_after)[1],
        "mins_since_break": mins_since_break(s),
        "last_break_at": s["last_break_at"],  # null = no break taken yet
        "break_taken_yet": s["last_break_at"] is not None,
        **extra,
    }
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def rest_relief(level_before: float, minutes: float) -> float:
    """One rest formula (same as the web app): the larger of plain decay or length-scaled relief, never both."""
    scaled = level_before * BREAK_RELIEF * min(1.0, minutes / BREAK_FULL_MIN)
    return min(level_before, max(DECAY_PER_MIN * minutes, scaled))


def reset_windows(s: dict) -> None:
    s["recent"] = []
    s["last_switch_penalty_at"] = None
    s["last_check_penalty_at"] = {}
    s["doom_streak"] = 0


def late_night(t: datetime) -> bool:
    return t.hour >= LATE_NIGHT_START or t.hour < LATE_NIGHT_END


def decayed(s: dict) -> float:
    idle = (now() - datetime.fromisoformat(s["updated_at"])).total_seconds() / 60
    return max(0.0, s["level"] - DECAY_PER_MIN * idle)


def settle(s: dict) -> float:
    """Apply decay up to now and store it."""
    s["level"] = decayed(s)
    s["updated_at"] = now().isoformat()
    return s["level"]


# --- display ---------------------------------------------------------------
def band(level: float):
    return next(b for b in BANDS if level <= b[0])


def bar(level: float, width: int = 20) -> str:
    n = round(level / 100 * width)
    return "█" * n + "░" * (width - n)


def since_break(s: dict) -> str:
    mins = mins_since_break(s)
    if s["last_break_at"]:
        return f"{mins} min since last break"
    return f"no break logged yet ({mins} min since tracking began)"


def status_line(level: float, s: dict) -> str:
    _, name, comment = band(level)
    color = {"calm": "green", "steady": "cyan", "loaded": "yellow", "frayed": "red"}[name]
    head = typer.style(f"[{bar(level)}] {level:.0f}%  {name.upper()}", fg=color, bold=True)
    return f"{head} - {comment}\n  {since_break(s)}"


# --- overstimulation response ---------------------------------------------
def copy_to_clipboard(text: str) -> bool:
    """Best effort, no extra dependency: the OS clipboard tool if one is installed."""
    for cmd in (["clip"], ["pbcopy"], ["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "-ib"]):
        if shutil.which(cmd[0]):
            try:
                subprocess.run(cmd, input=text.encode(), check=True)
                return True
            except (OSError, subprocess.CalledProcessError):
                pass
    return False


def roulette_morning() -> None:
    """The roulette "morning" mode: copy the morning list, wait a second, open the roulette."""
    copied = copy_to_clipboard(ROULETTE_MORNING_CLIPBOARD)
    time.sleep(ROULETTE_DELAY_S)
    webbrowser.open(ROULETTE_URL)
    typer.echo(typer.style("Morning reflections. Opening the roulette", fg="green", bold=True)
               + (" (list copied to clipboard)." if copied else "; couldn't copy, paste this list:\n" + ROULETTE_MORNING_CLIPBOARD))


def maybe_roulette(before: float, after: float, doomscrolling: bool = False, first_of_day: bool = False,
                   site_open: bool = False) -> None:
    """Copy a list and open the roulette site when the level crosses into frayed or a doomscroll streak hits
    (calming list), or on the first launch of the day (morning list; the calming list wins if both apply).
    site_open: the launch itself just opened the roulette, so don't open it twice."""
    frayed = band(before)[1] != "frayed" and band(after)[1] == "frayed"
    if not (frayed or doomscrolling or first_of_day):
        return
    calming = frayed or doomscrolling
    text = ROULETTE_CLIPBOARD if calming else ROULETTE_MORNING_CLIPBOARD
    copied = copy_to_clipboard(text)
    if not site_open:
        if not calming:
            time.sleep(ROULETTE_DELAY_S)  # first launch of the day: copy, wait, then open the roulette
        webbrowser.open(ROULETTE_URL)
    why = ("Lots of overstimulation" if frayed else f"{DOOMSCROLL_STREAK} doomscroll launches in a row"
           if doomscrolling else "First launch of the day")
    typer.echo(typer.style(f"{why}. Opening the roulette", fg="red" if calming else "green", bold=True)
               + (" (activity list copied to clipboard)." if copied else "; couldn't copy, paste this list:\n" + text))


# --- command parsing -------------------------------------------------------
def find_app(text: str):
    """Longest alias that prefixes `text` (word-boundary). Returns (app_key, rest)."""
    best = None
    for key, (aliases, *_rest) in APPS.items():
        for a in aliases:
            if (text == a or text.startswith(a + " ")) and (best is None or len(a) > len(best[1])):
                best = (key, a)
    if not best:
        return None, text
    return best[0], text[len(best[1]):].strip()


def find_activity(app_key: str, rest: str):
    """Pick activity from mode words; default if none. Returns (activity_id, error)."""
    _, _, default, supported = APPS[app_key]
    if not rest:
        return default, None
    words = rest.replace("-", "").split()
    joined = "".join(words)
    for act_id in supported:
        for kw in ACTIVITIES[act_id][2]:
            if kw in words or kw == joined:
                return act_id, None
    modes = sorted({kw for a in supported for kw in ACTIVITIES[a][2]})
    return None, f"'{rest}' isn't a mode for {app_key}. Modes: {', '.join(modes) or '(none)'}"


# --- handlers --------------------------------------------------------------
def do_open(s: dict, text: str) -> None:
    app_key, rest = find_app(text)
    if not app_key:
        typer.echo("Unknown app. Type 'apps' to list the inventory.")
        return
    act_id, err = find_activity(app_key, rest)
    if err:
        typer.echo(err)
        return
    label, weight, _ = ACTIVITIES[act_id]
    level_before = settle(s)

    typer.echo(f"Level before launch:\n  {status_line(level_before, s)}")

    # stimulating launches in the last CHECK_WINDOW_MIN, for the switching and checking-loop penalties
    t = now()
    cutoff = t - timedelta(minutes=CHECK_WINDOW_MIN)
    s["recent"] = [r for r in s.get("recent", []) if datetime.fromisoformat(r[0]) >= cutoff]
    points = weight * POINTS_PER_WEIGHT
    today = t.date().isoformat()
    first_of_day = act_id != "going_to_sleep" and s.get("last_open_date") != today  # a bedtime log doesn't use up the day's first launch
    if act_id != "going_to_sleep":
        s["last_open_date"] = today
    mult = NIGHT_MULT.get(act_id, LATE_NIGHT_MULT) if weight > 0 and late_night(t) else 1.0  # calming/neutral launches are never boosted
    note = ""
    sw = ck = 0.0
    repeat = None
    if weight > 0:  # calming launches (negative weight) neither count as switching/checking nor trigger the penalties
        s["recent"].append([t.isoformat(), app_key])
        within = lambda iso, m: t - datetime.fromisoformat(iso) < timedelta(minutes=m)
        last_sw = s.get("last_switch_penalty_at")
        if (len({a for ts, a in s["recent"] if within(ts, SWITCH_WINDOW_MIN)}) >= SWITCH_APPS
                and (not last_sw or not within(last_sw, SWITCH_WINDOW_MIN))):
            sw = ACTIVITIES["app_switching"][1] * POINTS_PER_WEIGHT
            s["last_switch_penalty_at"] = t.isoformat()
            note += f" (+{sw:.0f} app-switching penalty)"
        repeat = sum(1 for _, a in s["recent"] if a == app_key)
        last_ck = s.setdefault("last_check_penalty_at", {}).get(app_key)
        if repeat >= CHECK_REPEATS and (not last_ck or not within(last_ck, CHECK_WINDOW_MIN)):
            ck = ACTIVITIES["checking_loop"][1] * POINTS_PER_WEIGHT
            s["last_check_penalty_at"][app_key] = t.isoformat()
            note += f" (+{ck:.0f} checking loop)"
    points = (points + sw + ck) * mult
    if mult > 1:
        note += f" (x{mult:g} late night: prioritise sleep)"

    url = URL_OVERRIDES.get((app_key, act_id), APPS[app_key][1])
    morning_mode = act_id in ROULETTE_COPY_ACTIVITIES  # roulette "morning" mode copies, waits, then opens (below)
    if url and not morning_mode:  # dummy launches (sleep, back to work) have no url and only log
        webbrowser.open(url)

    s["level"] = max(0.0, min(100.0, level_before + points))
    # back-to-back doomscroll launches; any other launch (or a break) restarts the count
    s["doom_streak"] = s.get("doom_streak", 0) + 1 if act_id in DOOMSCROLL_ACTIVITIES else 0
    doomscrolling = s["doom_streak"] > 0 and s["doom_streak"] % DOOMSCROLL_STREAK == 0
    log("open", s, level_before, s["level"], command=text, app=app_key, activity=act_id,
        activity_label=label, weight=weight, points_added=round(points, 1),
        switch_penalty=round(sw, 1), check_penalty=round(ck * mult, 1), repeat_count=repeat, late_night_mult=mult, url=url,
        doom_streak=s["doom_streak"], first_of_day=first_of_day)
    typer.echo(f"{'Opening' if url else 'Logged'} {app_key}: {label} (weight {weight}) {points:+.0f}%{note}")
    typer.echo(f"Level now:\n  {status_line(s['level'], s)}")
    if morning_mode:
        roulette_morning()
    else:
        maybe_roulette(level_before, s["level"], doomscrolling, first_of_day, site_open=app_key == "roulette")


def do_show(s: dict) -> None:
    lvl = settle(s)
    log("show", s, lvl, lvl, command="show level")
    typer.echo(status_line(lvl, s))


def do_break(s: dict) -> None:
    before = settle(s)
    s["level"] = before * (1 - BREAK_RELIEF)
    log("break", s, before, s["level"], command="take break")  # mins_since_break = length of the stretch just ended
    s["last_break_at"] = now().isoformat()
    reset_windows(s)
    typer.echo(f"Break logged. Level {before:.0f}% -> {s['level']:.0f}%\n  {status_line(s['level'], s)}")


def do_feel(s: dict, arg: str) -> None:
    try:
        v = float(arg.strip().rstrip("%"))
        assert 0 <= v <= 100
    except (ValueError, AssertionError):
        typer.echo("Usage: feel <0-100>   e.g. feel 70")
        return
    before = settle(s)
    s["level"] = v
    log("feel", s, before, v, command="feel", felt=v, computed_level=round(before))
    typer.echo(f"Anchored. (computed was {before:.0f}%)\n  {status_line(v, s)}")
    maybe_roulette(before, v)


def maybe_auto_break(s: dict) -> None:
    """If the gap since the previous command exceeds the threshold, record an inferred break."""
    last = s.get("last_command_at")
    if not last:
        return
    idle = (now() - datetime.fromisoformat(last)).total_seconds() / 60
    if idle <= AUTO_BREAK_IDLE_MIN:
        return
    # level when the rest began (not decayed), then one rest formula for the whole gap
    before = max(0.0, s["level"] - DECAY_PER_MIN * max(0.0, (datetime.fromisoformat(last) - datetime.fromisoformat(s["updated_at"])).total_seconds() / 60))
    relief = rest_relief(before, idle)
    s["level"] = before - relief
    s["updated_at"] = now().isoformat()
    log("auto_break", s, before, s["level"], command="(idle gap)", idle_minutes=round(idle), inferred=True,
        break_minutes=round(idle, 2), relief=round(relief, 1))  # mins_since_break = length of the stretch just ended
    # the break is dated to when the idle threshold was crossed
    s["last_break_at"] = (datetime.fromisoformat(last) + timedelta(minutes=AUTO_BREAK_IDLE_MIN)).isoformat()
    reset_windows(s)
    typer.echo(f"Auto-break: {idle:.0f} min idle. Level {before:.0f}% -> {s['level']:.0f}%")


def do_apps() -> None:
    for key, (aliases, _u, default, supported) in APPS.items():
        modes = sorted({kw for a in supported for kw in ACTIVITIES[a][2]})
        typer.echo(f"{key:14} default: {default:16} modes: {', '.join(modes)}")


def handle(line: str) -> bool:
    """Returns False to quit."""
    text = " ".join(line.lower().split())
    if not text:
        return True
    if text in ("quit", "exit", "q"):
        return False
    s = load_state()
    if text in ("help", "?"):
        typer.echo(__doc__)
        return True
    if text == "apps":
        do_apps()
        return True
    if text not in ("take break", "break"):
        maybe_auto_break(s)
    if text in ("show level", "level"):
        do_show(s)
    elif text in ("take break", "break"):
        do_break(s)
    elif text.startswith("feel "):
        do_feel(s, text[5:])
    elif text.startswith("open "):
        do_open(s, text[5:])
    else:
        typer.echo("Didn't understand. Try: open <app> | show level | take break | feel <n> | apps | help")
        return True
    s["last_command_at"] = now().isoformat()
    save_state(s)
    return True


@app.command()
def main(command: Optional[List[str]] = typer.Argument(None, help='Optional one-shot command, e.g. "open instagram"')):
    """Interactive launcher. Pass a command for one-shot use, or none for a prompt."""
    if command:
        handle(" ".join(command))
        return
    typer.echo("Launcher ready. Type 'help' for commands, 'quit' to exit.")
    s = load_state()
    typer.echo(status_line(decayed(s), s))
    while True:
        try:
            line = input("\n> ")
        except (EOFError, KeyboardInterrupt):
            break
        if not handle(line):
            break


if __name__ == "__main__":
    app()
