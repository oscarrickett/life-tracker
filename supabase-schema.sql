-- Life Tracker — Supabase schema
-- Run once: Supabase dashboard → SQL Editor → New query → paste → Run.

create table if not exists public.days (
  user_id    uuid not null references auth.users(id) on delete cascade,
  date       text not null,                       -- ISO 'YYYY-MM-DD'
  hours      jsonb not null default '[]'::jsonb,  -- length 24, ints or null
  notes      text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

alter table public.days enable row level security;

drop policy if exists "select own days" on public.days;
drop policy if exists "insert own days" on public.days;
drop policy if exists "update own days" on public.days;
drop policy if exists "delete own days" on public.days;

create policy "select own days" on public.days
  for select using (auth.uid() = user_id);
create policy "insert own days" on public.days
  for insert with check (auth.uid() = user_id);
create policy "update own days" on public.days
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own days" on public.days
  for delete using (auth.uid() = user_id);

create index if not exists days_user_updated_idx
  on public.days(user_id, updated_at);

-- Per-user category overrides. Categories themselves come from seed.json
-- as defaults; rows here override name and/or color for a specific user.
create table if not exists public.categories (
  user_id    uuid not null references auth.users(id) on delete cascade,
  id         smallint not null,                  -- matches the in-app PALETTE id (1-20)
  name       text not null,
  color      text,                               -- hex string; null falls back to default
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.categories enable row level security;

drop policy if exists "select own categories" on public.categories;
drop policy if exists "insert own categories" on public.categories;
drop policy if exists "update own categories" on public.categories;
drop policy if exists "delete own categories" on public.categories;

create policy "select own categories" on public.categories
  for select using (auth.uid() = user_id);
create policy "insert own categories" on public.categories
  for insert with check (auth.uid() = user_id);
create policy "update own categories" on public.categories
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own categories" on public.categories
  for delete using (auth.uid() = user_id);
