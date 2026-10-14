-- ============================================================================
-- FN Hub CONTROL PLANE -- Reseller program v4: who sold each nation.
-- Run AFTER reseller.sql .. reseller_v3.sql, in the platform SQL Editor.
-- Idempotent -- safe to re-run.
--
-- nations.sold_by records the seller for reporting and accounting:
--   'owner'    -- a direct sale by the Owner (no commission)
--   'reseller' -- sold by a reseller; WHICH reseller agreement is the
--                 registered reseller_customers row for this subdomain (the
--                 same row commission statements are built from)
--   null       -- not recorded yet
-- nations_public lists its columns explicitly, so these stay private.
-- ============================================================================

alter table public.nations add column if not exists sold_by   text;
alter table public.nations add column if not exists sold_date date;
