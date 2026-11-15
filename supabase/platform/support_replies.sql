-- ============================================================================
-- FN Hub CONTROL PLANE -- support inbox reply thread.
-- Runs on the "fnhub-platform" project. Super-admins only. Run in the platform
-- SQL Editor (safe to re-run).
--
-- Adds a `replies` jsonb array to platform_support_tickets so the admin Support
-- inbox (Dashboard -> Support) shows a chat-style thread -- the original report
-- plus each staff reply -- and lets you reply inline. Each entry looks like:
--   { "by": "<sender email>", "at": "<iso>", "text": "<reply>", "to": "<reporter email>" }
-- Platform-side only; never pushed back to the nation. The platform-ticket-intake
-- function never writes this column, so re-forwarding a ticket leaves the thread
-- intact.
-- ============================================================================
alter table public.platform_support_tickets
  add column if not exists replies jsonb not null default '[]'::jsonb;
