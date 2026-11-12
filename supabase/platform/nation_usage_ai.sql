-- ============================================================================
-- FN Hub CONTROL PLANE -- per-nation AI token usage (this calendar month).
-- Runs on the "fnhub-platform" project (NOT a nation project). Super-admins
-- only (inherits nation_usage's existing RLS; no new policy needed).
--
-- report-nation-usage carries these up from each nation's hs_data_usage() along
-- with the db/storage byte counts. The admin panel prices them (Sonnet 5.5:
-- US$2 / M input, US$10 / M output) into the per-nation monthly hosting
-- estimate. They reflect the CURRENT calendar month and are overwritten on each
-- report (the push model), so they are a running month-to-date figure.
--
-- Run in the platform SQL Editor (AFTER nation_usage.sql).
-- ============================================================================

alter table public.nation_usage
  add column if not exists ai_input_tokens  bigint,
  add column if not exists ai_output_tokens bigint;
