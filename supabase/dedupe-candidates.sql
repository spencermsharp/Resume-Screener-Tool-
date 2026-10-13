-- ============================================================
-- DEDUPE CANDIDATES — audit + delete (Supabase SQL Editor)
-- Duplicate = same person (email OR last-10-digit phone) with 2+ applications
-- on the SAME position. Keeps the one furthest along; deletes the extras.
-- Run STEP 1 to review. Run STEP 2 to delete (export the table first as backup).
-- ============================================================

-- ── STEP 1: AUDIT (read-only) ─────────────────────────────────────────────────
with ranked as (
  select c.id,
    c.data->>'profileId' as position,
    coalesce(nullif(lower(trim(c.data#>>'{parsed,email}')),''),
             'p:'||nullif(right(regexp_replace(coalesce(c.data#>>'{parsed,phone}',''),'\D','','g'),10),'')) as person,
    c.data->>'stage' as stage,
    row_number() over (
      partition by c.data->>'profileId',
        coalesce(nullif(lower(trim(c.data#>>'{parsed,email}')),''),
                 'p:'||nullif(right(regexp_replace(coalesce(c.data#>>'{parsed,phone}',''),'\D','','g'),10),''))
      order by case c.data->>'stage'
        when 'hired' then 90 when 'offer' then 80 when 'hiring_mgr' then 70
        when 'mark_sharp' then 60 when 'hr' then 50 when 'future_fit' then 40
        when 'screened' then 30 when 'rejected' then 20 when 'out' then 10 else 0 end desc,
        coalesce(c.data->>'createdAt', c.updated_at::text) desc
    ) as rn
  from public.candidates c
  where coalesce(nullif(lower(trim(c.data#>>'{parsed,email}')),''),
                 nullif(right(regexp_replace(coalesce(c.data#>>'{parsed,phone}',''),'\D','','g'),10),'')) is not null
    and c.data->>'profileId' is not null
)
select person, position, stage, (rn = 1) as keeping, id
from ranked
where person in (select person from ranked group by person, position having count(*) > 1)
order by person, position, rn;


-- ── STEP 2: DELETE the extras (run after reviewing Step 1) ────────────────────
/*
with ranked as (
  select c.id,
    row_number() over (
      partition by c.data->>'profileId',
        coalesce(nullif(lower(trim(c.data#>>'{parsed,email}')),''),
                 'p:'||nullif(right(regexp_replace(coalesce(c.data#>>'{parsed,phone}',''),'\D','','g'),10),''))
      order by case c.data->>'stage'
        when 'hired' then 90 when 'offer' then 80 when 'hiring_mgr' then 70
        when 'mark_sharp' then 60 when 'hr' then 50 when 'future_fit' then 40
        when 'screened' then 30 when 'rejected' then 20 when 'out' then 10 else 0 end desc,
        coalesce(c.data->>'createdAt', c.updated_at::text) desc
    ) as rn
  from public.candidates c
  where coalesce(nullif(lower(trim(c.data#>>'{parsed,email}')),''),
                 nullif(right(regexp_replace(coalesce(c.data#>>'{parsed,phone}',''),'\D','','g'),10),'')) is not null
    and c.data->>'profileId' is not null
)
delete from public.candidates where id in (select id from ranked where rn > 1);
*/
