-- Run this once in the Supabase SQL editor for the live yo7 project.
-- Adds the notifications table to the supabase_realtime publication, so a
-- new row (order status change, admin announcement/offer broadcast, restock
-- alert) reaches a signed-in customer's open tab live. Without this, the
-- nav bell badge only ever picks up a new notification on the next full
-- page load, since the client's Realtime subscription has nothing to
-- receive, this table was simply never in the publication.
--
-- Safe to run more than once: the DO block only runs the ALTER PUBLICATION
-- when the table isn't already a member.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
END $$;
