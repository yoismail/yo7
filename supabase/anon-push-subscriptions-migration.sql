-- Run this once in the Supabase SQL editor for the live yo7 project.
-- One-time migration for anonymous push subscriptions (maybeAutoEnablePushOnInstall()
-- in src/index.html): installing the app should default push notifications
-- on even for a visitor who isn't signed in yet, so marketing broadcasts
-- (notifications.user_id IS NULL) can reach them too, not just signed-in
-- customers.
--
-- Safe to run more than once: the column change is a no-op once applied,
-- and each policy is dropped and recreated rather than failing if it
-- already exists.

alter table public.push_subscriptions alter column user_id drop not null;

comment on column public.push_subscriptions.user_id is 'NULL = an anonymous install (not signed in when it subscribed). Still reachable by a broadcast notification (user_id IS NULL in notifications), just not tied to an account.';

-- INSERT only, deliberately - see this policy's own comment in schema.sql
-- for why UPDATE/DELETE/SELECT aren't granted to anon here.
drop policy if exists "Anonymous installs can create a push subscription" on public.push_subscriptions;
create policy "Anonymous installs can create a push subscription" on public.push_subscriptions for insert to anon with check ((user_id is null));
