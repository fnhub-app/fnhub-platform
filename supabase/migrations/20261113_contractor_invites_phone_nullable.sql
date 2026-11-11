-- ════════════════════════════════════════════════════════════════════════════
-- Contractor Portal — allow email-only invites.
--
-- 20261101 created contractor_invites.phone as NOT NULL (phone was the only
-- sign-in channel). Now an invite may authorize just an EMAIL (no phone on the
-- contact), so phone must be nullable; otherwise an email-only invite insert
-- fails with a NOT NULL violation (HTTP 400). The claim still requires at least
-- one of phone/email to match, and the client never writes a row with neither.
--
-- Idempotent: dropping NOT NULL on an already-nullable column is a safe no-op.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.contractor_invites alter column phone drop not null;
