-- ============================================================================
-- 20261127_storage_rls_lockdown.sql
--
-- SECURITY FIX -- lock down Supabase Storage (storage.objects) for the
-- private `housing-files` bucket.
--
-- The bucket shipped with broad PERMISSIVE policies that granted EVERY signed-in
-- user (auth.role() = 'authenticated') SELECT / INSERT / UPDATE / DELETE on
-- EVERY object in the bucket:
--     "authenticated_read 58041z_0"   (SELECT, any authenticated)
--     "authenticated_delete 58041z_1" (SELECT, any authenticated)
--     "authenticated_delete 58041z_0" (DELETE, any authenticated)
--     "authenticated_insert 58041z_0" (INSERT, any authenticated)
--     "Allow authenticated uploads"   (INSERT, any authenticated, housing-files)
--     authenticated_update            (UPDATE, any authenticated)
--
-- Because PERMISSIVE policies are OR-ed together, those rules overrode the
-- owner/staff scoping added for application-intake
-- (20260728_application_intake_storage.sql). Any authenticated user -- INCLUDING
-- Contractor Portal and Community Portal users who sign in by phone/email OTP --
-- could read (and even delete) tenant documents, SOW files, inspection photos,
-- RFQ contracts, capital-project files and every other confidential housing
-- record by calling the Storage REST API directly with their own token,
-- bypassing the Edge-Function ownership checks.
--
-- This migration removes the broad policies and replaces them with scoped ones:
--   * Active STAFF (email in public.staff, is_active) keep full read/write/delete
--     across the housing-files bucket -- the staff app fetches and uploads files
--     directly with the staff JWT.
--   * Applicants keep owner-scoped access to their own
--     application-intake/<auth.uid()>/ folder (the intake_owner_* policies; an
--     intake_owner_update is added here so an applicant can still re-upload /
--     upsert into their own folder, which the broad authenticated_update used to
--     allow).
--   * Everyone else -- contractors, community members -- gets NO direct storage
--     access. Contractor Portal, tenant-MR, applicant-intake and email-intake
--     uploads/downloads run through Edge Functions
--     (contractor-upload / contractor-file / tenant-mr / applicant-intake /
--     email-intake) that use the service-role key and re-verify ownership, so
--     they are unaffected (service role bypasses RLS).
--
-- NOTE: storage.objects policies must be applied by the storage owner. The Fleet
-- Migrations runner has this right (20260728_application_intake_storage.sql
-- applied the same way). If a project's runner lacks it, this migration errors
-- for that project and the policies below must be applied by hand in the
-- Supabase dashboard -> Storage -> Policies.
-- ============================================================================

-- 1. Remove the broad "any authenticated user" policies.
drop policy if exists "Allow authenticated uploads"     on storage.objects;
drop policy if exists "authenticated_delete 58041z_0"   on storage.objects;
drop policy if exists "authenticated_delete 58041z_1"   on storage.objects;
drop policy if exists "authenticated_insert 58041z_0"   on storage.objects;
drop policy if exists "authenticated_read 58041z_0"     on storage.objects;
drop policy if exists authenticated_update              on storage.objects;
-- Legacy / template names that may linger from an earlier Supabase quick-start
-- or a partially-applied 20260703 lockdown.
drop policy if exists "Public Access"                   on storage.objects;
drop policy if exists "Give users access to own folder" on storage.objects;
drop policy if exists hs_storage_sel                    on storage.objects;
drop policy if exists hs_storage_ins                    on storage.objects;
drop policy if exists hs_storage_upd                    on storage.objects;
drop policy if exists hs_storage_del                    on storage.objects;

-- 2. Staff-scoped policies: active staff get full access to the housing-files
--    bucket. Uses the same inline staff check as intake_staff_select (proven to
--    work on storage.objects) rather than a helper function.
drop policy if exists hs_storage_staff_select on storage.objects;
create policy hs_storage_staff_select on storage.objects for select to authenticated
  using (
    bucket_id = 'housing-files'
    and exists (
      select 1 from public.staff s
      where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active
    )
  );

drop policy if exists hs_storage_staff_insert on storage.objects;
create policy hs_storage_staff_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'housing-files'
    and exists (
      select 1 from public.staff s
      where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active
    )
  );

drop policy if exists hs_storage_staff_update on storage.objects;
create policy hs_storage_staff_update on storage.objects for update to authenticated
  using (
    bucket_id = 'housing-files'
    and exists (
      select 1 from public.staff s
      where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active
    )
  )
  with check (
    bucket_id = 'housing-files'
    and exists (
      select 1 from public.staff s
      where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active
    )
  );

drop policy if exists hs_storage_staff_delete on storage.objects;
create policy hs_storage_staff_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'housing-files'
    and exists (
      select 1 from public.staff s
      where lower(s.email) = lower(auth.jwt() ->> 'email') and s.is_active
    )
  );

-- 3. Applicant owner-scoped UPDATE (completeness) -- an applicant may re-upload /
--    upsert files in only their own application-intake/<auth.uid()>/ folder.
--    The existing intake_owner_insert / intake_owner_select / intake_owner_delete
--    and intake_staff_select policies are intentionally LEFT IN PLACE.
drop policy if exists intake_owner_update on storage.objects;
create policy intake_owner_update on storage.objects for update to authenticated
  using (
    bucket_id = 'housing-files'
    and (storage.foldername(name))[1] = 'application-intake'
    and (storage.foldername(name))[2] = (auth.uid())::text
  )
  with check (
    bucket_id = 'housing-files'
    and (storage.foldername(name))[1] = 'application-intake'
    and (storage.foldername(name))[2] = (auth.uid())::text
  );
