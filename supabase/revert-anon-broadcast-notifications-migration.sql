-- Run this once in the Supabase SQL editor for the live yo7 project.
-- Reverts anon-broadcast-notifications-migration.sql: a signed-out
-- visitor should only ever get a broadcast as the real OS-level push
-- notification (already working - see maybeAutoEnablePushOnInstall()),
-- with its own link already wired up (sw.js's notificationclick), not a
-- browsable in-app list of everything ever sent. The in-app
-- #/notifications list goes back to signed-in only.
--
-- Safe to run more than once: the policy is dropped and recreated
-- rather than failing if it already exists.

drop policy if exists "Users can view own or broadcast notifications" on public.notifications;
create policy "Users can view own or broadcast notifications" on public.notifications for select using ((((auth.uid() is not null)) and ((auth.uid() = user_id) or (user_id is null))));
