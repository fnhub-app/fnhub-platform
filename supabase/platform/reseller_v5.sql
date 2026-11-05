-- ============================================================================
-- FN Hub CONTROL PLANE -- Reseller program v5: 18-month exclusivity default,
-- commission share on tagged Owner direct sales. Run AFTER reseller.sql ..
-- reseller_v4.sql, in the platform SQL Editor. Idempotent -- safe to re-run.
--
--   exclusivity_months       default 12 -> 18 (new agreements; existing rows keep
--                            their value -- edit a draft's field to change it)
--   owner_sale_share_pct     s.7.5: on an Owner direct sale the Owner TAGS as
--                            shared with this reseller (a reseller_customers row
--                            with status 'shared'), the reseller earns this % of
--                            the normal commission (50% x 33% = 16.5% of Net
--                            Revenue).
-- ============================================================================

alter table public.reseller_agreements alter column exclusivity_months set default 18;
alter table public.reseller_agreements add column if not exists owner_sale_share_pct numeric(5,2) not null default 50;
