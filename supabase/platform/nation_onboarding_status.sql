-- ============================================================================
-- FN Hub CONTROL PLANE -- per-nation onboarding stage flag.
-- Runs on the "fnhub-platform" project. Run in the platform SQL Editor.
--
-- A single at-a-glance stage for where a nation is in its onboarding journey,
-- set by super-admins on Dashboard -> (nation) -> Overview -> Status. This is
-- DISTINCT from `status` (provisioning | active | suspended, which controls
-- whether the nation publishes to nations_public and resolves on its subdomain).
-- Onboarding is the human/project-management state; status is the live/technical
-- state. Values: not_started | in_progress | blocked | ready | live | complete.
-- Null is treated as not_started in the UI.
-- ============================================================================

alter table public.nations
  add column if not exists onboarding_status text;
