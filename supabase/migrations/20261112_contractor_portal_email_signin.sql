-- ════════════════════════════════════════════════════════════════════════════
-- Contractor Portal — email sign-in (in addition to phone/SMS).
--
-- Contractors can now sign in with EITHER their mobile (SMS one-time code) OR
-- their email (6-digit email code). To authorize an email the same way a phone
-- is authorized, contractor_invites gets an `email` column, and contractor_users
-- records the email the login was linked with. Both are nullable — a given
-- invite may carry a phone, an email, or both.
--
-- Idempotent (add-column-if-not-exists); safe to re-run fleet-wide.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.contractor_invites add column if not exists email text;
alter table public.contractor_users   add column if not exists email text;
