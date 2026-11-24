-- Activity log: one row per change anyone makes in the app (who, what, when,
-- and the record before/after), plus sign-ins and sign-outs. Append-only for
-- the app: the anon key can add and read rows but never change or delete them.
-- Run once in the Supabase SQL Editor. Safe to run again.
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id text,
  user_name text,
  action text not null,
  entity text,
  entity_id text,
  summary text,
  before jsonb,
  after jsonb
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);
create index if not exists audit_log_user_at_idx on public.audit_log (user_id, at desc);
create index if not exists audit_log_entity_at_idx on public.audit_log (entity, at desc);

alter table public.audit_log enable row level security;
drop policy if exists "audit insert" on public.audit_log;
create policy "audit insert" on public.audit_log for insert to anon, authenticated with check (true);
drop policy if exists "audit read" on public.audit_log;
create policy "audit read" on public.audit_log for select to anon, authenticated using (true);
-- No update/delete policies, so RLS refuses both. TRUNCATE skips RLS, so take
-- that (and update/delete) away from the API roles outright.
grant select, insert on public.audit_log to anon, authenticated;
revoke update, delete, truncate on public.audit_log from anon, authenticated;
