-- ════════════════════════════════════════════════════════════════════════════
-- Support tickets (Help / Report-an-Issue help-desk queue).
--
-- Signed-in users (staff, community members, contractors) open the support
-- widget and either get help or file a ticket. A reporter is always an
-- AUTHENTICATED user, so the client inserts its own ticket directly (RLS gates
-- it to reporter_user_id = auth.uid()); the app then emails the nation's
-- support_email. Staff triage the queue in the app. (The AI layer's
-- `support-chat` Edge Function arrives in a later phase; S1a needs no function.)
--
-- Security boundary (OCAP — data stays in the nation's own project): no anon
-- access. Active staff read + update every ticket (to triage / resolve); a
-- reporter inserts + reads only their OWN tickets (reporter_user_id =
-- auth.uid()). No delete policy — rows are resolved by status, never removed.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.support_tickets (
  id               uuid primary key default gen_random_uuid(),
  nation           text,                                 -- subdomain label (clfn, …)
  source           text not null default 'staff',        -- staff | member | contractor
  reporter_user_id uuid,                                  -- auth.uid() of the submitter
  reporter_name    text,
  reporter_email   text,
  reporter_phone   text,
  reporter_role    text,                                  -- staff role, when source='staff'
  category         text not null default 'other',         -- app_bug | housing | feature | access | other
  subject          text,
  body             text,
  context          jsonb not null default '{}'::jsonb,    -- {page,url,app_version,user_agent,viewport}
  transcript       jsonb not null default '[]'::jsonb,    -- [{role,text,at}] (populated by the AI layer, S2)
  attachments      jsonb not null default '[]'::jsonb,    -- [{path,name,contentType,size}]
  status           text not null default 'new',           -- new | open | resolved
  assigned_to      text,
  assigned_at      timestamptz,
  resolution       text,
  resolved_by      text,
  resolved_at      timestamptz,
  source_ip        text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists support_tickets_status_idx   on public.support_tickets (status, created_at desc);
create index if not exists support_tickets_reporter_idx on public.support_tickets (reporter_user_id, created_at desc);

alter table public.support_tickets enable row level security;

-- Active staff read + triage every ticket.
drop policy if exists support_tickets_staff_read on public.support_tickets;
create policy support_tickets_staff_read on public.support_tickets
  for select using (
    exists (select 1 from public.staff s
            where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active)
  );

drop policy if exists support_tickets_staff_update on public.support_tickets;
create policy support_tickets_staff_update on public.support_tickets
  for update using (
    exists (select 1 from public.staff s
            where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active)
  );

-- A reporter (member / contractor / staff) reads only their own tickets.
drop policy if exists support_tickets_owner_read on public.support_tickets;
create policy support_tickets_owner_read on public.support_tickets
  for select using (reporter_user_id = auth.uid());

-- A reporter files a ticket as THEMSELVES (reporter_user_id must be their own
-- auth id). This is the only insert path — the client posts directly; there is
-- no anon path and no service-role function for S1a.
drop policy if exists support_tickets_owner_insert on public.support_tickets;
create policy support_tickets_owner_insert on public.support_tickets
  for insert with check (reporter_user_id = auth.uid());

-- Intentionally NO delete policy: tickets are resolved by status, never removed.
