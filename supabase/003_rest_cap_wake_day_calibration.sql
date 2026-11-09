-- Rest cap, wake-day first launch, glance discount, fatigue floor and prompted check-ins.
alter table public.events
  add column if not exists rest_credited_minutes numeric, -- break_end | auto_break: minutes that counted (min of elapsed and the cap)
  add column if not exists rest_capped boolean,           -- break_end | auto_break: true when elapsed exceeded the cap
  add column if not exists glance_refund numeric,         -- session_end: launch points handed back for a glance
  add column if not exists floor_applied numeric,         -- break_end | auto_break: points added by the fatigue floor (null when off)
  add column if not exists feel_source text,              -- feel: self | prompt_rest | prompt_high | prompt_random
  add column if not exists session_key text;              -- session_end: "<open ts ms>|<app>", one row per session

-- one session_end row per session (a second insert returns 409 and the client drops it)
create unique index if not exists events_session_end_once
  on public.events (user_id, session_key) where event = 'session_end' and session_key is not null;

-- calibration view for analysis
create or replace view public.feel_calibration with (security_invoker = true) as
select user_id, ts, wake_day, felt, computed_level, felt - computed_level as err,
       feel_source, feel_confirmed, scoring_version
from public.events where event = 'feel' and felt is not null;
