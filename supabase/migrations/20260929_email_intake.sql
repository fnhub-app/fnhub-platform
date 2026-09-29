-- ════════════════════════════════════════════════════════════════════════════
-- Email intake triage queue (forward-an-email-to-the-app).
--
-- Staff forward an email to a Cloudflare-routed address; a Cloudflare Email
-- Worker parses it and POSTs it to the `email-intake` Edge Function, which
-- stores the body + attachments in Storage and inserts ONE row here with the
-- SERVICE ROLE (bypassing RLS). Staff review each row in the app and assign it
-- to a unit / tenant with one click (triage-first: nothing is auto-filed).
--
-- Security boundary: external senders never touch production tables. This is
-- the quarantine, mirroring public.tenant_mr_submissions. No anon access; only
-- active staff may read + update (to assign / dismiss). No insert/delete policy
-- (inserts come only from the vetted Edge Function; rows resolve by status).
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.email_intake (
  id                 uuid primary key default gen_random_uuid(),
  message_id         text,                              -- RFC Message-ID, for dedupe
  from_email         text,
  from_name          text,
  to_email           text,
  subject            text,
  body_preview       text,                              -- short plain-text snippet for the list
  body_path          text,                              -- Storage path to the full body (.txt/.html)
  attachments        jsonb not null default '[]'::jsonb,-- [{path,name,contentType,size}]
  suggested_match    jsonb not null default '[]'::jsonb,-- [{type,unitId,label,reason}]
  status             text not null default 'new',       -- new | assigned | dismissed
  matched_unit_id    text,                              -- set when assigned to a unit
  matched_tenant_name text,
  filed_paths        jsonb not null default '[]'::jsonb,-- Storage paths filed to unit docs on assign
  assigned_by        text,
  assigned_at        timestamptz,
  assign_notes       text,
  source_ip          text,
  created_at         timestamptz not null default now()
);

create index if not exists email_intake_status_idx  on public.email_intake (status, created_at desc);
create index if not exists email_intake_unit_idx    on public.email_intake (matched_unit_id, created_at desc);
create unique index if not exists email_intake_msgid_idx
  on public.email_intake (message_id) where message_id is not null;

alter table public.email_intake enable row level security;

drop policy if exists email_intake_staff_read on public.email_intake;
create policy email_intake_staff_read on public.email_intake
  for select using (
    exists (select 1 from public.staff s
            where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active)
  );

drop policy if exists email_intake_staff_update on public.email_intake;
create policy email_intake_staff_update on public.email_intake
  for update using (
    exists (select 1 from public.staff s
            where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active)
  );

-- Intentionally NO insert or delete policy: inserts come only from the vetted
-- Edge Function (service role bypasses RLS); rows are resolved by status, never
-- removed.
