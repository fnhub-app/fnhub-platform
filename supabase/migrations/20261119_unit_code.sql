-- 20261119_unit_code.sql
-- Phase 1 of the Unit Codes & Key Inventory scope: a unique code per housing
-- unit (e.g. "CLFN-014"), shown on the inventory, the Edit Unit card and the
-- Tenant Information Card, and printable on a key tag instead of the address.
--
-- This migration adds the column + a unique index only. The code itself is
-- generated APP-SIDE (shared-data.js nextUnitCode / backfillUnitCodes), because
-- the prefix comes from the nation's own NATION_CONFIG.short and must never be a
-- hardcoded literal -- the database has no knowledge of the nation short name.
-- Existing units are back-filled the first time a management user opens the
-- Inventory page after this ships.

alter table public.housing_units
  add column if not exists unit_code text;

-- Unique only among assigned codes; many units may sit null until back-filled.
create unique index if not exists housing_units_unit_code_key
  on public.housing_units (unit_code)
  where unit_code is not null;
