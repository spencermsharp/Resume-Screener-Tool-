-- Creates the missing `blacklist` table (per-row, same shape as other data
-- tables) and its anon RLS policy. Run once in the Supabase SQL Editor.
create table if not exists public.blacklist (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.blacklist enable row level security;

drop policy if exists "anon full access" on public.blacklist;
create policy "anon full access" on public.blacklist
  for all to anon, authenticated using (true) with check (true);
