-- ============================================================
-- Vimenture / Kruew Hiring Platform — Supabase schema
-- Roles: 'admin' | 'user'
--   - Both roles use the full app.
--   - ONLY admins can add / manage other users (via the admin-users function).
-- Run this once in the Supabase SQL Editor.
-- ============================================================

-- Profiles: one row per auth user, holds display name + role.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  role text not null default 'user' check (role in ('admin','user')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Everyone signed in can read profiles (needed to show names/roles in the UI).
drop policy if exists "profiles readable by authenticated" on public.profiles;
create policy "profiles readable by authenticated"
  on public.profiles for select
  to authenticated
  using (true);

-- A user may update ONLY their own name (not their role — role changes go
-- through the admin-users function with the service role).
drop policy if exists "users update own name" on public.profiles;
create policy "users update own name"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));

-- Auto-create a profile row whenever a new auth user is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    coalesce(new.raw_user_meta_data->>'role', 'user')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- Application data tables (hiring platform).
-- Mirrors the local data model so going live is a storage swap.
-- All authenticated users share the same company-wide data for now
-- (admin/user differ only in user management). Tighten RLS later if needed.
-- ------------------------------------------------------------
create table if not exists public.positions (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.candidates (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.companies (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.placements (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.app_kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.positions   enable row level security;
alter table public.candidates  enable row level security;
alter table public.companies   enable row level security;
alter table public.placements  enable row level security;
alter table public.app_kv      enable row level security;

-- Authenticated users have full read/write to shared app data.
do $$
declare t text;
begin
  foreach t in array array['positions','candidates','companies','placements','app_kv']
  loop
    execute format('drop policy if exists "authenticated full access" on public.%I;', t);
    execute format(
      'create policy "authenticated full access" on public.%I for all to authenticated using (true) with check (true);', t
    );
  end loop;
end$$;

-- ------------------------------------------------------------
-- Storage bucket for resume PDFs (preview on candidate detail).
-- Public read so the <iframe> can display them; authenticated upload.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('resumes', 'resumes', true)
on conflict (id) do nothing;

drop policy if exists "resumes public read" on storage.objects;
create policy "resumes public read"
  on storage.objects for select
  using (bucket_id = 'resumes');

drop policy if exists "resumes auth upload" on storage.objects;
create policy "resumes auth upload"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'resumes');
