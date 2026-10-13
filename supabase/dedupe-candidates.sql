-- ============================================================
-- DEDUPE CANDIDATES — one-time audit + fix (run in Supabase SQL Editor)
-- A duplicate = the SAME person (matched by email OR phone) with 2+ applications
-- on the SAME position. We keep the application furthest along in the pipeline
-- and delete the extras.
--
-- candidates.data is jsonb: { profileId, stage, createdAt, parsed:{email,phone}, ... }
-- Run STEP 1 first to SEE duplicates. Only run STEP 2 (delete) once you're happy.
-- ============================================================

-- Normalizers as inline expressions:
--   email → lower(trim(...))
--   phone → last 10 digits of (digits only)
-- Stage ranking: later stage = higher rank (kept). Adjust order to match your pipeline.

-- Shared CTE used by both steps.
with norm as (
  select
    c.id,
    c.data->>'profileId'                                        as profile_id,
    nullif(lower(trim(c.data#>>'{parsed,email}')), '')          as email,
    nullif(right(regexp_replace(coalesce(c.data#>>'{parsed,phone}',''), '\D', '', 'g'), 10), '') as phone10,
    c.data->>'stage'                                            as stage,
    coalesce(c.data->>'createdAt', c.updated_at::text)          as created_at
  from public.candidates c
),
-- A stable identity key per person: prefer email, else phone. Rows with neither
-- are skipped (can't match safely).
keyed as (
  select *,
    case when email is not null then 'e:'||email
         when phone10 is not null then 'p:'||phone10
         else null end as person_key
  from norm
),
ranked as (
  select *,
    -- Higher number = further along = the one to KEEP.
    case stage
      when 'hired' then 90
      when 'offer' then 80
      when 'hiring_mgr' then 70
      when 'mark_sharp' then 60
      when 'hr' then 50
      when 'future_fit' then 40
      when 'screened' then 30
      when 'rejected' then 20
      when 'out' then 10
      else 0
    end as stage_rank
  from keyed
  where person_key is not null and profile_id is not null
),
groups as (
  select person_key, profile_id, count(*) as n
  from ranked
  group by person_key, profile_id
  having count(*) > 1
),
-- Within each (person, position) group, number rows: keep rn=1 (furthest along,
-- then newest), delete rn>1.
to_delete as (
  select r.id,
         r.person_key, r.profile_id, r.stage, r.created_at,
         row_number() over (
           partition by r.person_key, r.profile_id
           order by r.stage_rank desc, r.created_at desc
         ) as rn
  from ranked r
  join groups g on g.person_key = r.person_key and g.profile_id = r.profile_id
)

-- ── STEP 1: AUDIT — review the duplicate groups (nothing is changed) ──────────
select person_key, profile_id,
       count(*) as copies,
       string_agg(stage || ' (' || left(id,12) || ')', ', ' order by rn) as applications
from to_delete
group by person_key, profile_id
order by copies desc;

-- ── STEP 2: FIX — delete the extras, keep the best one per group ──────────────
-- Self-contained. Run ONLY after reviewing Step 1. (Tip: take a backup/export of
-- the candidates table first — this permanently deletes the duplicate rows.)
/*
with norm as (
  select
    c.id,
    c.data->>'profileId' as profile_id,
    nullif(lower(trim(c.data#>>'{parsed,email}')), '') as email,
    nullif(right(regexp_replace(coalesce(c.data#>>'{parsed,phone}',''), '\D', '', 'g'), 10), '') as phone10,
    c.data->>'stage' as stage,
    coalesce(c.data->>'createdAt', c.updated_at::text) as created_at
  from public.candidates c
),
keyed as (
  select *,
    case when email is not null then 'e:'||email
         when phone10 is not null then 'p:'||phone10
         else null end as person_key
  from norm
),
ranked as (
  select *,
    case stage
      when 'hired' then 90 when 'offer' then 80 when 'hiring_mgr' then 70
      when 'mark_sharp' then 60 when 'hr' then 50 when 'future_fit' then 40
      when 'screened' then 30 when 'rejected' then 20 when 'out' then 10 else 0 end as stage_rank
  from keyed
  where person_key is not null and profile_id is not null
),
to_delete as (
  select id,
    row_number() over (
      partition by person_key, profile_id
      order by stage_rank desc, created_at desc
    ) as rn
  from ranked
)
delete from public.candidates
where id in (select id from to_delete where rn > 1);
*/
