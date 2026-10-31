-- ════════════════════════════════════════════════════════════════════════════
-- SMS / text notifications (Phase 1).
--
-- Mirrors the email pipeline: a `send-sms` Edge Function sends via a per-nation
-- provider (Twilio default) using the caller's staff JWT, and logs every send.
-- Nothing sends without THREE gates all passing: the `sms_notifications`
-- module on, the per-event SMS channel on, and the recipient opted in (and not
-- globally opted out). This migration adds only the data those gates need.
--
-- CONSENT IS A LEGAL GATE (CASL): a recipient receives SMS only when
-- `sms_opt_in = true`, and a STOP reply writes `sms_optouts` (enforced in the
-- Edge Function with the service role), which overrides opt-in for that number.
--
-- Run by the user in the Supabase SQL Editor (not via this repo), fleet-wide.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Per-recipient mobile + consent ──────────────────────────────────────────
-- sms_number is stored E.164 (+1...), validated/normalized client-side; it is
-- deliberately distinct from the existing free-form `phone` so a bad legacy
-- phone can never be texted. opt_in/opt_out timestamps are the CASL audit trail.
alter table public.tenants             add column if not exists sms_number     text;
alter table public.tenants             add column if not exists sms_opt_in      boolean not null default false;
alter table public.tenants             add column if not exists sms_opt_in_at   timestamptz;
alter table public.tenants             add column if not exists sms_opt_out_at  timestamptz;

alter table public.staff               add column if not exists sms_number     text;
alter table public.staff               add column if not exists sms_opt_in      boolean not null default false;
alter table public.staff               add column if not exists sms_opt_in_at   timestamptz;
alter table public.staff               add column if not exists sms_opt_out_at  timestamptz;

alter table public.housing_contractors add column if not exists sms_number     text;
alter table public.housing_contractors add column if not exists sms_opt_in      boolean not null default false;
alter table public.housing_contractors add column if not exists sms_opt_in_at   timestamptz;
alter table public.housing_contractors add column if not exists sms_opt_out_at  timestamptz;

-- ── Global opt-out ledger (STOP) ────────────────────────────────────────────
-- STOP is per-NUMBER, not per-person: one mobile may appear on several records,
-- so opt-out is checked by number. The Edge Function inserts here (service role)
-- when a provider reports an opt-out, and checks it before every send.
create table if not exists public.sms_optouts (
  phone       text primary key,            -- E.164
  source      text,                        -- 'stop_reply' | 'provider' | 'manual'
  created_at  timestamptz not null default now()
);

alter table public.sms_optouts enable row level security;

drop policy if exists sms_optouts_staff_read on public.sms_optouts;
create policy sms_optouts_staff_read on public.sms_optouts
  for select using (
    exists (select 1 from public.staff s
            where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active)
  );
-- No insert/delete policy: the opt-out ledger is written only by the vetted
-- Edge Function (service role bypasses RLS). Staff read it to see who opted out.

-- ── Delivery log (append-only) ──────────────────────────────────────────────
-- SMS has provider-specific state the audit log doesn't model (SID, delivery
-- receipt, carrier error code), so it gets its own table. A short summary row
-- still mirrors into housing_audit_log from the Edge Function as 'sms_sent'.
create table if not exists public.sms_log (
  id                   uuid primary key default gen_random_uuid(),
  provider             text,                               -- 'twilio' | ...
  provider_sid         text,                               -- provider message id
  to_number            text,                               -- E.164
  event                text,                               -- registry event key
  entity_type          text,
  entity_id            text,
  status               text not null default 'sent',       -- sent | delivered | failed | skipped_optout
  error_code           text,
  detail               text,
  actor                text,                               -- JWT email of the sender
  delivery_receipt_at  timestamptz,
  created_at           timestamptz not null default now()
);

create index if not exists sms_log_created_idx on public.sms_log (created_at desc);
create index if not exists sms_log_event_idx   on public.sms_log (event, created_at desc);

alter table public.sms_log enable row level security;

drop policy if exists sms_log_staff_read on public.sms_log;
create policy sms_log_staff_read on public.sms_log
  for select using (
    exists (select 1 from public.staff s
            where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active)
  );
-- No insert/delete policy: inserts come only from the Edge Function (service
-- role); the log is append-only and never pruned from the client.
