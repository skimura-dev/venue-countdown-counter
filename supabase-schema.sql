create table if not exists public.event_state (
  id integer primary key default 1,
  state jsonb not null,
  updated_at timestamptz not null default now(),
  constraint event_state_single_row check (id = 1)
);

create table if not exists public.event_answers (
  id text primary key,
  client_id text not null,
  team text not null check (team in ('A', 'B')),
  answer text not null check (answer in ('○', '×')),
  points integer not null default 0,
  question_id integer not null,
  question text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique (question_id, client_id)
);

create table if not exists public.event_manual (
  id text primary key,
  applied_at timestamptz not null default now(),
  question_id integer not null,
  question text not null,
  team text not null,
  answer text not null,
  points integer not null default 0,
  score_a integer not null,
  score_b integer not null,
  note text not null default ''
);

insert into public.event_state (id, state)
values (
  1,
  '{
    "teamAName": "チームA",
    "teamBName": "チームB",
    "startNumber": 1000,
    "scoreA": 1000,
    "scoreB": 1000,
    "currentTeam": "A",
    "turn": 1,
    "turnLabel": "1ターン目",
    "questionId": 1,
    "question": "今日関東から来た人",
    "answerDuration": 60,
    "answerDeadline": null,
    "winMode": "zero",
    "latest": null
  }'::jsonb
)
on conflict (id) do nothing;

alter table public.event_state enable row level security;
alter table public.event_answers enable row level security;
alter table public.event_manual enable row level security;

drop policy if exists "event_state_select" on public.event_state;
drop policy if exists "event_state_insert" on public.event_state;
drop policy if exists "event_state_update" on public.event_state;
drop policy if exists "event_answers_select" on public.event_answers;
drop policy if exists "event_answers_insert" on public.event_answers;
drop policy if exists "event_answers_update" on public.event_answers;
drop policy if exists "event_manual_select" on public.event_manual;
drop policy if exists "event_manual_insert" on public.event_manual;

create policy "event_state_select" on public.event_state for select to anon using (true);
create policy "event_state_insert" on public.event_state for insert to anon with check (id = 1);
create policy "event_state_update" on public.event_state for update to anon using (id = 1) with check (id = 1);

create policy "event_answers_select" on public.event_answers for select to anon using (true);
create policy "event_answers_insert" on public.event_answers for insert to anon with check (true);
create policy "event_answers_update" on public.event_answers for update to anon using (true) with check (true);

create policy "event_manual_select" on public.event_manual for select to anon using (true);
create policy "event_manual_insert" on public.event_manual for insert to anon with check (true);

create index if not exists event_answers_question_status_idx
on public.event_answers (question_id, status, answer);

create index if not exists event_manual_applied_at_idx
on public.event_manual (applied_at desc);
