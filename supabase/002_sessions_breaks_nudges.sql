-- Sessions, rest, wake/sleep, context, check-in confirmation and nudges.
-- New event values: session_end | break_end | wake | context | nudge | nudge_outcome
-- (existing: open | show | break | auto_break | feel)
alter table public.events
  add column if not exists wake_day date,             -- every event: local date of the most recent wake
  add column if not exists session_minutes numeric,   -- session_end
  add column if not exists ended_by text,             -- session_end: return | answered | default | next_action
  add column if not exists check_penalty numeric,     -- open: checking-loop penalty applied
  add column if not exists repeat_count int,          -- open: launches of this app in the last CHECK_WINDOW_MIN
  add column if not exists break_minutes numeric,     -- break_end | auto_break | wake: length of the rest
  add column if not exists relief numeric,            -- break_end | auto_break | wake: level_before - level_after
  add column if not exists sleep_start timestamptz,   -- wake
  add column if not exists sleep_minutes int,         -- wake
  add column if not exists sleep_source text,         -- wake: logged | inferred
  add column if not exists tag text,                  -- context: sleep_quality | day_load | meal | caffeine | with_people | alone | stress | exercise | outside
  add column if not exists tag_value text,            -- context: e.g. poor/ok/good, light/normal/heavy, or 'yes'
  add column if not exists feel_confirmed boolean,    -- feel: true when the large-jump confirm was used
  add column if not exists nudge_id text,             -- nudge | nudge_outcome
  add column if not exists nudge_reason text,         -- nudge: frayed_roulette | doomscroll_roulette | morning_roulette | loaded_band
  add column if not exists nudge_outcome text,        -- nudge_outcome: break | calming | roulette | ignored | none | superseded
  add column if not exists response_min numeric,      -- nudge_outcome: minutes from nudge to the deciding action
  add column if not exists scoring_version text;      -- every event: which scoring rules produced it (null = before sessions)
