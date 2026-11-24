-- Member (applicant) portal: text-notification opt-in.
-- Adds the opt-in flag, mobile number (E.164), and consent timestamp to the
-- member's profile. The applicant-intake Edge Function writes these with the
-- service role (the table's UPDATE policy is staff-only) AFTER verifying the
-- member's own JWT (uid). The member's own SELECT policy already returns these
-- columns, so the portal reads them back on sign-in. Run fleet-wide.

alter table public.applicant_profiles
  add column if not exists sms_opt_in     boolean not null default false,
  add column if not exists sms_number     text,
  add column if not exists sms_consent_at timestamptz;
