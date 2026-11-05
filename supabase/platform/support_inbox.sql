-- ============================================================================
-- FN Hub CONTROL PLANE -- aggregated support inbox.
-- Runs on the "fnhub-platform" project. Super-admins only. Run in the platform
-- SQL Editor.
--
-- Each nation's own `support_tickets` table (per-nation project) is the source
-- of truth for its tickets. When a ticket is filed, the nation's
-- `support-forward` Edge Function mirrors a LIGHT copy (no base64 attachments or
-- chat transcript) into this control-plane table via the `platform-ticket-intake`
-- function, so the platform owner sees one cross-nation worklist in the admin
-- panel (Dashboard -> Support). Platform-side triage fields (platform_status /
-- assigned_to / resolved_*) live only here and are never pushed back to a nation.
--
-- Dedupe is on (subdomain, nation_ticket_id): a re-forward of the same ticket
-- UPDATES the mirrored content + nation_status, and deliberately does NOT reset
-- the platform-side triage columns (the intake omits them from the upsert).
-- ============================================================================
create table if not exists public.platform_support_tickets (
  id                uuid primary key default gen_random_uuid(),
  subdomain         text,
  nation_name       text,
  nation_ticket_id  text,
  source            text,            -- staff | member | contractor
  category          text,
  subject           text,
  body              text,
  reporter_name     text,
  reporter_email    text,
  reporter_phone    text,
  reporter_role     text,
  context           jsonb,
  attachment_count  integer not null default 0,
  nation_status     text,            -- the ticket's status on the nation (new/open/resolved)
  nation_created_at timestamptz,
  received_at       timestamptz not null default now(),
  -- Platform-side triage (control plane only; never sent back to the nation):
  platform_status   text not null default 'new',   -- new | open | resolved
  assigned_to       text,
  resolved_by       text,
  resolved_at       timestamptz,
  notes             text,
  updated_at        timestamptz not null default now(),
  unique (subdomain, nation_ticket_id)
);

create index if not exists platform_support_tickets_status_idx
  on public.platform_support_tickets (platform_status, received_at desc);

alter table public.platform_support_tickets enable row level security;

-- Super-admins only, end to end. The intake Edge Function uses the service role
-- (which bypasses RLS), so no insert policy is needed for the mirror; a browser
-- session only ever reads/triages as a verified platform administrator.
drop policy if exists platform_support_tickets_all on public.platform_support_tickets;
create policy platform_support_tickets_all on public.platform_support_tickets for all
  using (public.is_super_admin()) with check (public.is_super_admin());
