-- ============================================================================
-- FN Hub CONTROL PLANE -- Reseller program v3: in-panel e-signatures.
-- Run AFTER reseller.sql and reseller_v2.sql, in the platform SQL Editor.
-- Idempotent -- safe to re-run.
--
-- Each party can sign the agreement inside the admin panel (s.17.9 allows
-- electronic signature). The value is either a PNG data URL of a drawn
-- signature or 'typed:<name>' for a typed one; it is stamped onto the
-- agreement PDF. Changing the terms after signing clears both signatures.
-- ============================================================================

alter table public.reseller_agreements add column if not exists owner_signature    text;
alter table public.reseller_agreements add column if not exists reseller_signature text;
