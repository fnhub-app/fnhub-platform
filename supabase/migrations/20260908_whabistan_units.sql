-- ============================================================================
-- Whabistan units import — 8 one-bedroom units (5 lots)
--   Lot 10:  2A, 2B     Lot 11: 3A, 3B     Lot 12: 5B
--   Lot 13:  7B         Lot 158: 9A, 9B
-- All: 1 bedroom, ~500 sq ft, CMHC Section 95 funded, VACANT (ready for
-- assignment through Match). Community address: Constance Lake First Nation,
-- P0L 1B0 (recorded in the unit notes — units carry only num + street).
-- Run by the user in the Supabase SQL Editor (nation project).
--
-- Defensive like the FNCBRP import: ON CONFLICT (id) DO NOTHING so an
-- existing unit at the same address slug is never touched; once-only audit
-- rows; verification SELECT at the end (expect 8 rows).
-- ============================================================================

BEGIN;

WITH w(id, num, lot) AS (VALUES
  ('WHABISTAN-2A', '2A', 'Lot 10'),
  ('WHABISTAN-2B', '2B', 'Lot 10'),
  ('WHABISTAN-3A', '3A', 'Lot 11'),
  ('WHABISTAN-3B', '3B', 'Lot 11'),
  ('WHABISTAN-5B', '5B', 'Lot 12'),
  ('WHABISTAN-7B', '7B', 'Lot 13'),
  ('WHABISTAN-9A', '9A', 'Lot 158'),
  ('WHABISTAN-9B', '9B', 'Lot 158')
)
INSERT INTO housing_units (id, num, street, bedrooms, bathrooms, type, funder, status, archived, under_renovation, accessible, is_elders, data)
SELECT
  w.id, w.num, 'Whabistan', 1, '1', 'duplex unit', 'CMHC_95', 'vacant', false, false, false, false,
  jsonb_build_object(
    'id', w.id,
    'num', w.num,
    'street', 'Whabistan',
    'bedrooms', 1,
    'bathrooms', '1',
    'type', 'duplex unit',
    'funder', 'CMHC_95',
    'status', 'vacant',
    'squareFeet', 500,
    'lot', w.lot,
    'notes',
      w.lot || ' Whabistan — Constance Lake First Nation, P0L 1B0. '
      || '1-bedroom unit, approx. 500 sq ft. Funding: CMHC Section 95. '
      || 'Imported 2026-09-08 from the housing department unit list.'
  )
FROM w
ON CONFLICT (id) DO NOTHING;

-- Provenance audit rows (append-only log; written once).
INSERT INTO housing_audit_log (entity_type, entity_id, action, detail, actor)
SELECT 'unit', 'UNIT:' || u.id, 'unit_edit',
       jsonb_build_object(
         'detail', 'Unit imported: ' || u.num || ' Whabistan (' || (u.data->>'lot')
           || ') — 1-bed, ~500 sq ft, CMHC Section 95, vacant',
         'name', 'Whabistan import'
       )::text,
       'whabistan-import'
FROM housing_units u
WHERE u.street = 'Whabistan' AND u.data->>'lot' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM housing_audit_log a
    WHERE a.entity_id = 'UNIT:' || u.id AND a.actor = 'whabistan-import'
  );

COMMIT;

-- Verification: expect 8 rows, all vacant, funder CMHC_95.
SELECT id, num, street, bedrooms, funder, status, data->>'lot' AS lot, data->>'squareFeet' AS sqft
FROM housing_units
WHERE street = 'Whabistan'
ORDER BY num;
