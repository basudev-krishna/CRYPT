-- =============================================================================
-- Administrators can correct a member's username and phone
-- =============================================================================
-- Until now username and phone were fixed after sign-up. Administrators now
-- create logins for members and need to fix typos or rename a login later, so
-- the web role may update them. Only the admin route writes them (permission
-- member.edit, audited with before/after values). Format and uniqueness stay
-- enforced by the existing check constraint and unique index. Member id and
-- sponsor stay guarded by user_profiles_identity_guard.

grant update (username, phone) on public.user_profiles to app_web;
