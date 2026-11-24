-- Member maintenance-request texting (Phase 2b).
-- Store the reporting member's email on their portal maintenance submission so
-- staff can text their CONSENTED portal number (applicant_profiles opt-in) when
-- the request is reviewed. QR-flow (anonymous) submissions leave it null and are
-- never texted. Run fleet-wide.

alter table public.tenant_mr_submissions
  add column if not exists reporter_email text;
