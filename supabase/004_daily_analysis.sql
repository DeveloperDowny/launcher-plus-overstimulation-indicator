-- End-of-day overstimulation analysis, computed on demand in the browser (web/report.js) and saved per day.
-- One row per tester per wake day (4 AM to 4 AM, local time); "Redo analysis" overwrites it.
create table if not exists public.daily_analysis (
  id bigint generated always as identity primary key,
  user_id text not null,
  wake_day date not null,
  created_at timestamptz not null default now(),  -- when this version of the analysis was computed
  analysis_version text,                          -- report.js ANALYSIS_VERSION that produced it
  analysis jsonb not null,                        -- the whole computed analysis (metrics, curve, launches, moments)
  unique (user_id, wake_day)
);

-- Same access model as events and feedback: no auth for now (explicit decision), anon may read and write.
alter table public.daily_analysis enable row level security;
create policy "anon all daily_analysis" on public.daily_analysis for all to anon using (true) with check (true);
