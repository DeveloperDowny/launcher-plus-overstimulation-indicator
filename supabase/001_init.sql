-- One row per CLI log.txt line, tagged with the tester's user_id.
create table public.events (
  id bigint generated always as identity primary key,
  user_id text not null,
  ts timestamptz not null default now(),
  date date, hour int, weekday text,
  event text not null,                 -- open | show | break | auto_break | feel
  command text,
  level_before int, band_before text,
  level_after int,  band_after text,
  mins_since_break int, last_break_at timestamptz, break_taken_yet boolean,
  app text, activity text, activity_label text, weight int,
  points_added numeric, switch_penalty numeric, url text,
  felt numeric, computed_level int,    -- feel events
  idle_minutes int, inferred boolean,  -- auto_break events
  break_at timestamptz                 -- break / auto_break events: when the break counts from
);
create index events_user_ts on public.events (user_id, ts desc);

create table public.feedback (
  id bigint generated always as identity primary key,
  user_id text not null,
  ts timestamptz not null default now(),
  kind text not null,                  -- accuracy | text
  accurate boolean,
  felt numeric, computed_level int,
  message text
);

-- No auth for now (explicit decision): anon may insert/read.
alter table public.events enable row level security;
alter table public.feedback enable row level security;
create policy "anon all events" on public.events for all to anon using (true) with check (true);
create policy "anon all feedback" on public.feedback for all to anon using (true) with check (true);

-- Kill / double-down metric: distinct active days per tester.
create view public.tester_summary with (security_invoker = true) as
select user_id,
       count(*) filter (where event = 'open') as launches,
       count(distinct date) as active_days,
       count(*) filter (where event = 'feel') as feels,
       round(avg(abs(felt - computed_level)) filter (where event = 'feel'), 1) as avg_feel_gap,
       min(ts) as first_seen, max(ts) as last_seen
from public.events group by user_id;
