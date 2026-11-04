-- Run this once in the Supabase SQL editor for the live yo7 project.
-- One-time migration for the categorized push-notification preferences
-- on #/notifications (renderPushToggle()/savePushPrefs() in
-- src/index.html): lets a subscriber turn Order Updates, Announcements
-- and Offers on/off independently instead of one all-or-nothing push
-- toggle. Every existing subscription defaults to all three ON, so
-- nobody already subscribed sees their notifications go quiet.
--
-- Also requires deploying the new update-push-preferences Edge Function
-- (used for an anonymous install's own changes, since push_subscriptions'
-- anon RLS policy is deliberately INSERT-only, see that policy's own
-- comment in schema.sql):
--   supabase functions deploy update-push-preferences
--
-- Safe to run more than once: adding a column that already exists is a
-- no-op.

alter table public.push_subscriptions add column if not exists notify_orders boolean not null default true;
alter table public.push_subscriptions add column if not exists notify_announcements boolean not null default true;
alter table public.push_subscriptions add column if not exists notify_offers boolean not null default true;

comment on column public.push_subscriptions.notify_orders is 'Per-device preference from the #/notifications page, matches notifications.category = order. Default true: every new subscription opts in to everything.';
comment on column public.push_subscriptions.notify_announcements is 'Per-device preference from the #/notifications page, matches notifications.category = announcement. Default true: every new subscription opts in to everything.';
comment on column public.push_subscriptions.notify_offers is 'Per-device preference from the #/notifications page, matches notifications.category = offer. Default true: every new subscription opts in to everything. Does not gate category = restock/reward, which are always a specific customer''s own opted-in alert, never a broadcast, and have no toggle on that page.';
