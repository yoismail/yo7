-- Run this once in the Supabase SQL editor for the live yo7 project.
-- One-time migration so a signed-out visitor can see broadcast
-- notifications (announcements/offers) on #/notifications
-- (loadNotificationsWithReadState()/renderNotificationsPage() in
-- src/index.html), not just receive them as push. Anonymous installs can
-- already get push (see anon-push-subscriptions-migration.sql) - hiding
-- the in-app list behind a login wall undercut the point of that.
--
-- A targeted notification (a specific order's status, a loyalty reward)
-- always has a real user_id, so this only ever exposes a broadcast row
-- (user_id IS NULL) to a signed-out visitor, never anyone else's own
-- notifications.
--
-- Safe to run more than once: the policy is dropped and recreated
-- rather than failing if it already exists.

drop policy if exists "Users can view own or broadcast notifications" on public.notifications;
create policy "Users can view own or broadcast notifications" on public.notifications for select using (((auth.uid() = user_id) or (user_id is null)));
