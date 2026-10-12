-- ============================================================
-- Seed the FIRST admin user directly in SQL.
-- Website username: Spencermsharp   (stored as spencermsharp@users.local)
-- Temp password:    ChangeMe!2026   ← change it right after first login
--
-- Login is by USERNAME. Supabase Auth needs an email identifier, so usernames
-- are stored as <username>@users.local. No real email is ever used or sent.
--
-- Run this ONCE in the Supabase SQL Editor AFTER running schema.sql.
-- If your Supabase version rejects the insert, create the user via
-- Authentication → Users → Add user with email  spencermsharp@users.local.
-- ============================================================

create extension if not exists pgcrypto;

insert into auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values (
  '00000000-0000-0000-0000-000000000000',
  gen_random_uuid(),
  'authenticated',
  'authenticated',
  'spencermsharp@users.local',
  crypt('ChangeMe!2026', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"name":"Spencer","role":"admin"}',
  now(),
  now()
)
on conflict (email) do nothing;

insert into auth.identities (
  id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(),
  u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email),
  'email',
  u.email,
  now(), now(), now()
from auth.users u
where u.email = 'spencermsharp@users.local'
on conflict do nothing;

insert into public.profiles (id, name, role)
select u.id, 'Spencer', 'admin'
from auth.users u
where u.email = 'spencermsharp@users.local'
on conflict (id) do update set role = 'admin', name = 'Spencer';
