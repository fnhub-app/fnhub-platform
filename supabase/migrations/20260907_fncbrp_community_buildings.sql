-- ============================================================================
-- FNCBRP Community Buildings import — 16 commercial/band buildings
-- Source: IESO First Nation Community Building Retrofit Program (FNCBRP)
--         BCR + Participant Agreement, signed 2025-10-24
--         (F25073_FNCBRP_BCR_and_Participant_Agreement_SIGNED_20251028.pdf,
--          "Community Buildings" schedule, rows 1-16).
-- Run by the user in the Supabase SQL Editor (nation project) — the standard
-- path for schema/data work in this repo.
--
-- What this does, in order:
--   1. INSERTs one housing_units row per building (type 'band_building',
--      status 'occupied', ON CONFLICT (id) DO NOTHING so an existing unit at
--      the same address slug is never touched). The full unit object rides
--      the data jsonb exactly as sbSaveUnit writes it (buildingName,
--      squareFeet, notes), so the app loads these like app-created units.
--   2. UPDATEs assigned_name to the building/function name as a SEPARATE
--      statement — this fires the tenants-sync trigger's update path, so a
--      department tenancy row is minted exactly as if staff had typed the
--      name into the unit card. Scoped to rows this script created
--      (type band_building AND assigned_name IS NULL) so a pre-existing
--      unit at a colliding id is never renamed.
--   3. Types the minted tenants rows tenant_type='department' (scoped to
--      these unit ids + these names only).
--   4. Writes one audit row per building for provenance.
--   5. Verification SELECTs at the end — confirm 16 rows (or see which ids
--      collided) before closing the editor.
--
-- Naming notes (two rows normalized to the street spellings already used by
-- the app's existing unit data):
--   - Row 6  "31 Wa Wa Ska Shoo"  -> street 'Wa Wa Ska Shoo Street'
--   - Row 15 "4 Shan Way Shoo"    -> street 'Shanwayshoo Street'
-- Building types are all 'band_building'; retype individual ones (e.g. the
-- Post Office to commercial_building) in the Edit Unit modal if preferred.
-- ============================================================================

BEGIN;

-- 0. The tenants_tenant_type_chk CHECK constraint predates the 'department'
--    and 'business' values the app's commercial-building flow writes
--    (sbTypeCommercialTenantForAssignment) -- step 3 below, and that app
--    flow itself, both fail against it. Extend it IN PLACE: the original
--    expression is kept verbatim and OR'd with the two new values, so every
--    currently-allowed value stays allowed. No-op if already extended.
DO $$
DECLARE
  def  text;
  expr text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conname = 'tenants_tenant_type_chk' AND conrelid = 'tenants'::regclass;
  IF def IS NULL THEN
    RAISE NOTICE 'tenants_tenant_type_chk not found - nothing to extend';
  ELSIF def LIKE '%department%' THEN
    RAISE NOTICE 'tenants_tenant_type_chk already allows department - unchanged';
  ELSE
    expr := regexp_replace(def, '^CHECK\s*', '', 'i');
    EXECUTE 'ALTER TABLE tenants DROP CONSTRAINT tenants_tenant_type_chk';
    EXECUTE 'ALTER TABLE tenants ADD CONSTRAINT tenants_tenant_type_chk CHECK ('
            || expr || ' OR tenant_type IN (''department'', ''business''))';
    RAISE NOTICE 'tenants_tenant_type_chk extended (was: %)', def;
  END IF;
END $$;

WITH b(id, num, street, bname, sqft, note) AS (VALUES
  ('WA-WA-SKA-SHOO-STREET-37',  '37',  'Wa Wa Ska Shoo Street', 'Band Office',                    3000,
   'Used daily by members, workers, and clients. Requires LED lighting upgrades and other energy conservation measures for energy efficiency and a properly lit work environment.'),
  ('NES-QUA-STREET-3',          '3',   'Nes-qua Street',        'Ontario Works',                  2500,
   'Used daily by workers and clients. Requires LED lighting upgrades and other energy conservation measures for energy efficiency and a properly lit work environment.'),
  ('NES-QUA-STREET-17',         '17',  'Nes-qua Street',        'Ambulance Services',             2055,
   'Requires LED lighting upgrades and other energy conservation measures for energy efficiency and a properly lit work environment.'),
  ('MUSKO-ROAD-2',              '2',   'Musko Road',            'School',                         4530,
   'High energy consumer according to the Community Energy Plan completed in 2018. Used daily by students, teachers, and other workers. Requires LED lighting upgrades and other energy conservation measures for energy efficiency and a properly lit work environment.'),
  ('NES-QUA-STREET-1',          '1',   'Nes-qua Street',        'Health Centre',                  4845,
   'High energy consumer according to the Community Energy Plan completed in 2018. Used daily by workers and clients. Requires LED lighting upgrades and other energy conservation measures for energy efficiency and a properly lit work environment.'),
  ('WA-WA-SKA-SHOO-STREET-31',  '31',  'Wa Wa Ska Shoo Street', 'Community Hall',                 2410,
   'Requires LED lighting upgrades and other energy conservation measures for energy efficiency and a properly lit work environment.'),
  ('SAGATAY-CRESCENT-10',       '10',  'Sagatay Crescent',      'Elders Complex',                 10250,
   'High energy consumer according to the Community Energy Plan completed in 2018. Used daily by workers and residents. Requires LED lighting upgrades and other energy conservation measures for energy efficiency and a properly lit work environment.'),
  ('WA-WA-SKA-SHOO-STREET-32',  '32',  'Wa Wa Ska Shoo Street', 'Water Treatment Plant',          390,
   'High energy consumer. Vital service with day to day operations. Requires LED lighting upgrades and other energy conservation measures for energy efficiency and a properly lit work environment.'),
  ('NABAKHOBO-STREET-11',       '11',  'Nabakhobo Street',      'Recreation Centre',              1860,
   'Requires LED lighting upgrades and other energy conservation measures for energy efficiency and a properly lit work environment.'),
  ('WA-WA-SKA-SHOO-STREET-33',  '33',  'Wa Wa Ska Shoo Street', 'Public Works Garage',            4000,
   'Requires LED lighting upgrades and other energy conservation measures for energy efficiency and a properly lit work environment.'),
  ('WA-WA-SKA-SHOO-STREET-35',  '35',  'Wa Wa Ska Shoo Street', 'Shipping and Receiving Building', 300,
   'Requires LED lighting upgrades and other energy conservation measures for energy efficiency and a properly lit work environment.'),
  ('WA-WA-SKA-SHOO-STREET-37A', '37A', 'Wa Wa Ska Shoo Street', 'Boardroom',                      900,
   'Requires LED lighting upgrades and other energy conservation measures for energy efficiency and a properly lit work environment.'),
  ('WA-WA-SKA-SHOO-STREET-37B', '37B', 'Wa Wa Ska Shoo Street', 'Post Office',                    1200,
   'Requires LED lighting upgrades and other energy conservation measures for energy efficiency and a properly lit work environment.'),
  ('WA-WA-SKA-SHOO-STREET-37C', '37C', 'Wa Wa Ska Shoo Street', 'Land and Resource Building',     2200,
   'Requires LED lighting upgrades and other energy conservation measures for energy efficiency and a properly lit work environment.'),
  ('SHANWAYSHOO-STREET-4',      '4',   'Shanwayshoo Street',    'Choose Life Building',           1100,
   'Requires LED lighting upgrades and other energy conservation measures for energy efficiency and a properly lit work environment.'),
  ('ROGERS-ROAD-1',             '1',   'Rogers Road',           'Firetruck Garage',               3000,
   'Requires LED lighting upgrades and other energy conservation measures for energy efficiency and a properly lit work environment.')
)
INSERT INTO housing_units (id, num, street, type, status, archived, under_renovation, accessible, is_elders, data)
SELECT
  b.id, b.num, b.street, 'band_building', 'occupied', false, false, false, false,
  jsonb_build_object(
    'id', b.id,
    'num', b.num,
    'street', b.street,
    'type', 'band_building',
    'status', 'occupied',
    'buildingName', b.bname,
    'squareFeet', b.sqft,
    'notes',
      'FNCBRP (IESO First Nation Community Building Retrofit Program) Community Buildings schedule — BCR + Participant Agreement signed 2025-10-24. '
      || 'Gross floor area: ' || b.sqft::text || ' sq ft. '
      || 'Energy suppliers: Hydro One (electricity), Enbridge (natural gas). '
      || 'Energy efficiency retrofits / renewable generation completed since 2019: none. '
      || 'Retrofit priority: ' || b.note || ' '
      || 'COVID-19 usage impact: the building has not been impacted over the long term.'
  )
FROM b
ON CONFLICT (id) DO NOTHING;

-- 2. Assigned name as a separate UPDATE so the tenants-sync trigger's update
--    path fires (same as staff typing the name on the unit card). Only rows
--    this script created are touched.
UPDATE housing_units u SET assigned_name = v.bname
FROM (VALUES
  ('WA-WA-SKA-SHOO-STREET-37',  'Band Office'),
  ('NES-QUA-STREET-3',          'Ontario Works'),
  ('NES-QUA-STREET-17',         'Ambulance Services'),
  ('MUSKO-ROAD-2',              'School'),
  ('NES-QUA-STREET-1',          'Health Centre'),
  ('WA-WA-SKA-SHOO-STREET-31',  'Community Hall'),
  ('SAGATAY-CRESCENT-10',       'Elders Complex'),
  ('WA-WA-SKA-SHOO-STREET-32',  'Water Treatment Plant'),
  ('NABAKHOBO-STREET-11',       'Recreation Centre'),
  ('WA-WA-SKA-SHOO-STREET-33',  'Public Works Garage'),
  ('WA-WA-SKA-SHOO-STREET-35',  'Shipping and Receiving Building'),
  ('WA-WA-SKA-SHOO-STREET-37A', 'Boardroom'),
  ('WA-WA-SKA-SHOO-STREET-37B', 'Post Office'),
  ('WA-WA-SKA-SHOO-STREET-37C', 'Land and Resource Building'),
  ('SHANWAYSHOO-STREET-4',      'Choose Life Building'),
  ('ROGERS-ROAD-1',             'Firetruck Garage')
) AS v(id, bname)
WHERE u.id = v.id AND u.type = 'band_building' AND u.assigned_name IS NULL;

-- 3. Type the trigger-minted tenancy rows as departments (never touches a
--    person: scoped to these exact names AND these exact units).
UPDATE tenants t SET tenant_type = 'department', current_unit_id = COALESCE(t.current_unit_id, v.id)
FROM (VALUES
  ('WA-WA-SKA-SHOO-STREET-37',  'Band Office'),
  ('NES-QUA-STREET-3',          'Ontario Works'),
  ('NES-QUA-STREET-17',         'Ambulance Services'),
  ('MUSKO-ROAD-2',              'School'),
  ('NES-QUA-STREET-1',          'Health Centre'),
  ('WA-WA-SKA-SHOO-STREET-31',  'Community Hall'),
  ('SAGATAY-CRESCENT-10',       'Elders Complex'),
  ('WA-WA-SKA-SHOO-STREET-32',  'Water Treatment Plant'),
  ('NABAKHOBO-STREET-11',       'Recreation Centre'),
  ('WA-WA-SKA-SHOO-STREET-33',  'Public Works Garage'),
  ('WA-WA-SKA-SHOO-STREET-35',  'Shipping and Receiving Building'),
  ('WA-WA-SKA-SHOO-STREET-37A', 'Boardroom'),
  ('WA-WA-SKA-SHOO-STREET-37B', 'Post Office'),
  ('WA-WA-SKA-SHOO-STREET-37C', 'Land and Resource Building'),
  ('SHANWAYSHOO-STREET-4',      'Choose Life Building'),
  ('ROGERS-ROAD-1',             'Firetruck Garage')
) AS v(id, bname)
WHERE t.full_name = v.bname
  AND (t.current_unit_id IS NULL OR t.current_unit_id = v.id)
  AND t.merged_into IS NULL;

-- 4. Provenance audit rows (append-only log). Matches the app's conventions:
--    entity_id 'UNIT:<id>' + entity_type 'unit' + detail as the {detail,name}
--    JSON blob the audit UI parses, action 'unit_edit' (the unit-save key).
INSERT INTO housing_audit_log (entity_type, entity_id, action, detail, actor)
SELECT 'unit', 'UNIT:' || u.id, 'unit_edit',
       jsonb_build_object(
         'detail', 'Community building imported from the FNCBRP BCR + Participant Agreement (signed 2025-10-24): '
           || (u.data->>'buildingName') || ' — ' || u.num || ' ' || u.street
           || ' (' || (u.data->>'squareFeet') || ' sq ft)',
         'name', 'FNCBRP import'
       )::text,
       'fncbrp-import'
FROM housing_units u
WHERE u.type = 'band_building' AND u.data->>'notes' LIKE 'FNCBRP (IESO First Nation Community Building Retrofit Program)%'
  AND NOT EXISTS (
    SELECT 1 FROM housing_audit_log a
    WHERE a.entity_id = 'UNIT:' || u.id AND a.actor = 'fncbrp-import'
  );

COMMIT;

-- ── Verification (run after COMMIT; read-only) ──────────────────────────────
-- Expect 16 rows here; fewer means an id collided with an existing unit
-- (that unit was left untouched — review it by id):
SELECT id, num, street, assigned_name, data->>'squareFeet' AS sqft
FROM housing_units
WHERE type = 'band_building'
  AND data->>'notes' LIKE 'FNCBRP (IESO First Nation Community Building Retrofit Program)%'
ORDER BY street, num;

-- Department tenancy rows minted by the sync trigger (expect up to 16;
-- zero rows only means the tenants-sync trigger is not installed, which is
-- harmless — the unit cards still show the building name):
SELECT id, full_name, tenant_type, current_unit_id
FROM tenants
WHERE tenant_type = 'department' AND merged_into IS NULL
ORDER BY full_name;
