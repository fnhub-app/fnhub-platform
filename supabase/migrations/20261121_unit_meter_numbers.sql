-- Add hydro/gas meter-number columns to housing_units.
--
-- These columns ship in the bootstrap schema (supabase/bootstrap/schema.sql) so
-- NEW nations have them, but they were never added to existing nation databases
-- via a migration. CLFN's live database predates that schema line, so the
-- columns are missing there.
--
-- The app writes them as REAL top-level columns -- sbSaveUnit (shared-data.js)
-- adds row.hydro_meter_number / row.gas_meter_number to the upsert whenever a
-- value is present, and the TIC Utilities tab's saveTarget:'unit' fields PATCH
-- them directly. When the column is missing, PostgREST rejects the whole
-- request (PGRST204, "Could not find the '...' column ... in the schema cache"),
-- so entering a meter number makes the entire unit save fail -- which presents
-- as "hydro/gas meter numbers won't save."
--
-- Idempotent; safe to run fleet-wide and safe to re-run.

alter table public.housing_units
  add column if not exists hydro_meter_number text,
  add column if not exists gas_meter_number   text;

-- Recover any meter value an earlier save happened to land in the data jsonb
-- blob (sbSaveUnit always also writes data: u). sbLoadUnits reads the column
-- first and falls back to data, so this keeps both in sync and loses nothing.
update public.housing_units
   set hydro_meter_number = data->>'hydro_meter_number'
 where hydro_meter_number is null
   and coalesce(data->>'hydro_meter_number', '') <> '';

update public.housing_units
   set gas_meter_number = data->>'gas_meter_number'
 where gas_meter_number is null
   and coalesce(data->>'gas_meter_number', '') <> '';
