-- 20261120_unit_keys.sql
-- Phase 2 of the Unit Codes & Key Inventory scope: per-unit key inventory.
-- One row per physical key, keyed to the unit (and its unit_code). Tracks type,
-- status, who holds it, and the current issue/return cycle; the full chain of
-- custody lives in housing_audit_log (key_added / key_issued / key_returned /
-- key_lost / key_retired). Created / issued / returned from the housing side via
-- REST (shared-data.js) using the staff bearer token.
--
-- RLS: the housing office (management + housing employees) reads, creates and
-- edits keys (issue / return). Retiring a key is a management-only action,
-- enforced in the UI. Keys are never hard-deleted (archived = true).
-- Requires the RLS helpers from 20260703_rls_lockdown.sql (public.hs_is_office).

create table if not exists public.housing_unit_keys (
  id            uuid primary key default gen_random_uuid(),
  nation_id     text,
  unit_id       text,                                  -- housing_units.id (address slug)
  unit_code     text,                                  -- denormalized for printing / contractor view
  key_type      text,                                  -- house | mailbox | garage | mechanical | other
  label         text,                                  -- optional human label (e.g. "front door")
  status        text not null default 'on_hand',       -- on_hand | issued | lost | retired
  holder_name   text,                                  -- who currently holds it
  holder_kind   text,                                  -- staff | tenant | contractor
  issued_at     timestamptz,
  returned_at   timestamptz,
  notes         text,
  archived      boolean not null default false,
  created_by    text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index if not exists housing_unit_keys_unit_idx
  on public.housing_unit_keys (unit_id) where archived = false;

alter table public.housing_unit_keys enable row level security;

-- Office reads + creates + edits (issue / return / mark lost / retire). The
-- management-only restriction on "retire" is enforced in the UI; RLS keeps the
-- floor at office tier. No delete policy -- rows are archived, never deleted.
drop policy if exists housing_unit_keys_select on public.housing_unit_keys;
create policy housing_unit_keys_select on public.housing_unit_keys
  for select to authenticated using (public.hs_is_office());

drop policy if exists housing_unit_keys_insert on public.housing_unit_keys;
create policy housing_unit_keys_insert on public.housing_unit_keys
  for insert to authenticated with check (public.hs_is_office());

drop policy if exists housing_unit_keys_update on public.housing_unit_keys;
create policy housing_unit_keys_update on public.housing_unit_keys
  for update to authenticated using (public.hs_is_office()) with check (public.hs_is_office());
