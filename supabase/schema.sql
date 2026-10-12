-- ============================================================
-- Resume Screener Tool — Supabase schema (Qualis pattern)
-- No Supabase Auth. Logins live in app_users (username + role + password).
-- Static site talks to these tables via the REST API with the anon key.
-- Run this once in the Supabase SQL Editor.
-- ============================================================

-- Users (logins). Roles: 'admin' | 'user'. Admin's only extra power is adding users.
create table if not exists public.app_users (
  id text primary key,
  username text unique not null,
  name text not null default '',
  role text not null default 'user' check (role in ('admin','user')),
  password_hash text not null default '',
  password_plain text not null default '',
  status text not null default 'active',
  created_at timestamptz not null default now()
);

-- Application data tables (key/jsonb — mirrors the local model, storage swap).
create table if not exists public.positions   (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists public.candidates  (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists public.people      (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists public.companies   (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists public.placements  (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists public.blacklist   (id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists public.app_kv      (key text primary key, value jsonb not null, updated_at timestamptz not null default now());

-- RLS: enable, then allow the anon role full access (same trust model as the
-- other tools — this is an internal app behind a login the app enforces).
alter table public.app_users   enable row level security;
alter table public.positions   enable row level security;
alter table public.candidates  enable row level security;
alter table public.people      enable row level security;
alter table public.companies   enable row level security;
alter table public.placements  enable row level security;
alter table public.blacklist   enable row level security;
alter table public.app_kv      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['app_users','positions','candidates','people','companies','placements','blacklist','app_kv']
  loop
    execute format('drop policy if exists "anon full access" on public.%I;', t);
    execute format('create policy "anon full access" on public.%I for all to anon, authenticated using (true) with check (true);', t);
  end loop;
end$$;

-- ------------------------------------------------------------
-- Storage bucket for resume PDFs (preview on candidate detail).
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('resumes', 'resumes', true)
on conflict (id) do nothing;

drop policy if exists "resumes public read" on storage.objects;
create policy "resumes public read" on storage.objects for select using (bucket_id = 'resumes');

drop policy if exists "resumes anon upload" on storage.objects;
create policy "resumes anon upload" on storage.objects for insert to anon, authenticated with check (bucket_id = 'resumes');
