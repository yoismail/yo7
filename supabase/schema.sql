SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";




COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";




CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";




CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";




CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";




CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";




CREATE OR REPLACE FUNCTION "public"."assign_order_number"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.order_number := 'YO7-' || lpad(nextval('public.orders_order_number_seq')::text, 4, '0');
  return new;
end;
$$;


ALTER FUNCTION "public"."assign_order_number"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_best_sellers"("p_days" integer DEFAULT 30, "p_limit" integer DEFAULT 12) RETURNS TABLE("product_id" "text", "units_sold" numeric)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select (item->>'id') as product_id, sum(coalesce((item->>'qty')::numeric, 0)) as units_sold
  from public.orders o, jsonb_array_elements(o.items) as item
  where o.created_at >= now() - (p_days || ' days')::interval
    and o.status not in ('cancelled', 'returned')
    and item->>'id' is not null
  group by (item->>'id')
  order by units_sold desc
  limit p_limit;
$$;


ALTER FUNCTION "public"."get_best_sellers"("p_days" integer, "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_units_sold"("p_product_keys" "text"[]) RETURNS TABLE("product_key" "text", "units_sold" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select pk, sum((item->>'qty')::int) as units_sold
  from orders,
       jsonb_array_elements(items) as item,
       unnest(p_product_keys) as pk
  where status <> 'cancelled'
    and (item->>'id' = pk or item->>'id' like pk || '::%')
  group by pk;
$$;


ALTER FUNCTION "public"."get_units_sold"("p_product_keys" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
  insert into public.profiles (id, full_name, phone, email)
  values (new.id, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'phone', new.email);
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_purchased_product"("p_user_id" "uuid", "p_product_key" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.orders o, jsonb_array_elements(o.items) as item
    where o.user_id = p_user_id
      and auth.uid() = p_user_id
      and o.status not in ('cancelled', 'returned')
      and item->>'id' = p_product_key
  );
$$;


ALTER FUNCTION "public"."has_purchased_product"("p_user_id" "uuid", "p_product_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin_user"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;


ALTER FUNCTION "public"."is_admin_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."issue_loyalty_reward_if_earned"("p_order_id" "uuid") RETURNS TABLE("pct" numeric)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user_id uuid;
  v_order_total numeric;
  v_threshold numeric;
  v_pct numeric;
  v_has_pending boolean;
begin
  select user_id, total into v_user_id, v_order_total from public.orders where id = p_order_id;
  if v_user_id is null or v_user_id <> auth.uid() then
    raise exception 'Not authorized';
  end if;

  select spend_threshold, reward_pct into v_threshold, v_pct from public.loyalty_settings limit 1;

  if v_order_total < v_threshold then
    return; -- this order alone didn't meet the threshold
  end if;

  select exists(select 1 from public.loyalty_rewards where user_id = v_user_id and used = false) into v_has_pending;
  if v_has_pending then
    return; -- already has one unused reward, doesn't stack
  end if;

  insert into public.loyalty_rewards (user_id, pct) values (v_user_id, v_pct);
  pct := v_pct;
  return next;
end;
$$;


ALTER FUNCTION "public"."issue_loyalty_reward_if_earned"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_loyalty_reward_used"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update public.loyalty_rewards
  set used = true, used_at = now()
  where id = (
    select id from public.loyalty_rewards
    where user_id = auth.uid() and used = false
    order by earned_at asc
    limit 1
  );
end;
$$;


ALTER FUNCTION "public"."mark_loyalty_reward_used"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_order_status_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_email text;
  v_api_key text;
  v_copy record;
  v_admin record;
  v_customer_name text;
  v_item_count int;
begin
  -- Only a brand new order emails automatically. A later status update is
  -- the admin's explicit "Send email to customer" action instead
  -- (send_order_status_email below) — see migration 10 for why: so an
  -- admin can save a status/comment change silently, or resend the same
  -- notification, without every save doubling up as an email.
  if tg_op = 'UPDATE' then
    return new;
  end if;

  select decrypted_secret into v_api_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_api_key is null then
    return new; -- Resend not configured yet, see setup-order-emails.md
  end if;

  -- ---- Customer confirmation ----
  select email into v_email from public.profiles where id = new.user_id;
  if v_email is not null then
    select * into v_copy from public.order_status_email_copy(new.status, new.cancellation_reason);
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_api_key,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'from', 'Yo7 Foods <orders@yo7foods.co.uk>',
        'to', v_email,
        'subject', v_copy.subject || ' — ' || coalesce(new.order_number, new.id::text),
        'html',
          '<div style="font-family:''Montserrat Alternates'',Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;">' ||
          '<h2 style="color:#063B00;">' || v_copy.headline || '</h2>' ||
          '<p>' || v_copy.body || '</p>' ||
          '<p style="color:#666;font-size:13px;">Order ' || coalesce(new.order_number, new.id::text) || ' &middot; Total ' || to_char(new.total, 'FM£999999990.00') || '</p>' ||
          '<p style="margin:24px 0;"><a href="https://yo7foods.co.uk/#/orders" style="background:#90B800;color:#063B00;font-weight:bold;text-decoration:none;padding:12px 28px;border-radius:8px;display:inline-block;">View your orders</a></p>' ||
          '<p style="color:#999;font-size:12px;">Yo7 Foods &middot; 7 Lancaster Road, Ipswich, IP4 2NY</p>' ||
          '</div>',
        'text',
          v_copy.headline || E'\n\n' || v_copy.body || E'\n\n' ||
          'Order ' || coalesce(new.order_number, new.id::text) || ' · Total ' || to_char(new.total, 'FM£999999990.00') || E'\n' ||
          'View your orders: https://yo7foods.co.uk/#/orders' || E'\n\n' ||
          'Yo7 Foods · 7 Lancaster Road, Ipswich, IP4 2NY'
      )
    );
  end if;

  -- ---- New-order admin alert (unchanged in shape since migration 12/17) ----
  select coalesce(full_name, email) into v_customer_name from public.profiles where id = new.user_id;
  v_item_count := (select count(*) from jsonb_array_elements(new.items));
  for v_admin in select email from public.profiles where is_admin = true and email is not null loop
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_api_key,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'from', 'Yo7 Foods <orders@yo7foods.co.uk>',
        'to', v_admin.email,
        'subject', 'New order ' || coalesce(new.order_number, new.id::text) || ' — ' || to_char(new.total, 'FM£999999990.00'),
        'html',
          '<div style="font-family:''Montserrat Alternates'',Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;">' ||
          '<h2 style="color:#063B00;">New order received</h2>' ||
          '<p>' || coalesce(v_customer_name, 'A customer') || ' just placed order ' || coalesce(new.order_number, new.id::text) || '.</p>' ||
          '<p style="color:#333;font-size:14px;">' ||
            v_item_count || ' item' || (case when v_item_count = 1 then '' else 's' end) || ' &middot; ' ||
            (case when new.fulfilment_method = 'pickup' then 'Pickup' else 'Delivery' end) || ' &middot; ' ||
            'Total ' || to_char(new.total, 'FM£999999990.00') ||
          '</p>' ||
          '<p style="margin:24px 0;"><a href="https://yo7foods.co.uk/#/admin/order/' || new.id::text || '" style="background:#90B800;color:#063B00;font-weight:bold;text-decoration:none;padding:12px 28px;border-radius:8px;display:inline-block;">View order</a></p>' ||
          '<p style="color:#999;font-size:12px;">Yo7 Foods admin notifications</p>' ||
          '</div>',
        'text',
          'New order received' || E'\n\n' ||
          coalesce(v_customer_name, 'A customer') || ' just placed order ' || coalesce(new.order_number, new.id::text) || '.' || E'\n' ||
          v_item_count || ' item' || (case when v_item_count = 1 then '' else 's' end) || ' · ' ||
          (case when new.fulfilment_method = 'pickup' then 'Pickup' else 'Delivery' end) || ' · Total ' || to_char(new.total, 'FM£999999990.00') || E'\n\n' ||
          'View order: https://yo7foods.co.uk/#/admin/order/' || new.id::text
      )
    );
  end loop;

  return new;
end;
$$;


ALTER FUNCTION "public"."notify_order_status_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."order_status_email_copy"("p_status" "text", "p_reason" "text") RETURNS TABLE("subject" "text", "headline" "text", "body" "text")
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select
    case p_status
      when 'placed' then 'Order received'
      when 'being_prepared' then 'Your order is being prepared'
      when 'out_for_delivery' then 'Your order is out for delivery'
      when 'ready_for_pickup' then 'Your order is ready for pickup'
      when 'delivered' then 'Your order has been delivered'
      when 'cancelled' then 'Your order has been cancelled'
      when 'returned' then 'Your order has been marked as returned'
      else 'Order update'
    end,
    case p_status
      when 'placed' then 'Thanks, we''ve got your order'
      when 'being_prepared' then 'We''re getting your order ready'
      when 'out_for_delivery' then 'On its way to you'
      when 'ready_for_pickup' then 'Ready to collect'
      when 'delivered' then 'Delivered'
      when 'cancelled' then 'This order was cancelled'
      when 'returned' then 'This order was returned'
      else 'Status updated'
    end,
    case p_status
      when 'placed' then 'We''ve received your order and will start preparing it shortly.'
      when 'being_prepared' then 'Your order has been confirmed and is now being prepared.'
      when 'out_for_delivery' then 'Your order has left us and is on its way to you.'
      when 'ready_for_pickup' then 'Your order is packed and ready to collect in store: 7 Lancaster Road, Ipswich, IP4 2NY.'
      when 'delivered' then 'Your order has been delivered. We hope you enjoy it!'
      when 'cancelled' then coalesce('Reason: ' || p_reason, 'This order has been cancelled.')
      when 'returned' then 'This order has been logged as returned. We''ll be in touch about next steps if we haven''t already.'
      else 'Your order status has changed.'
    end;
$$;


ALTER FUNCTION "public"."order_status_email_copy"("p_status" "text", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prevent_self_admin_escalation"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.is_admin is distinct from old.is_admin and not public.is_admin_user() then
    new.is_admin := old.is_admin;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."prevent_self_admin_escalation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prune_pending_checkouts"("older_than" interval DEFAULT '24:00:00'::interval) RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  delete from public.pending_checkouts where created_at < now() - older_than;
$$;


ALTER FUNCTION "public"."prune_pending_checkouts"("older_than" interval) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prune_rate_limit_hits"("older_than" interval DEFAULT '01:00:00'::interval) RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  delete from public.rate_limit_hits where created_at < now() - older_than;
$$;


ALTER FUNCTION "public"."prune_rate_limit_hits"("older_than" interval) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_discount_redemption"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.discount_id is not null then
    insert into public.discount_redemptions (discount_id, user_id, order_id)
    values (new.discount_id, new.user_id, new.id);
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."record_discount_redemption"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."register_coming_soon_interest"("p_email" "text", "p_postcode" "text" DEFAULT NULL::"text", "p_source" "text" DEFAULT 'homepage_coming_soon'::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_api_key text;
  v_new_id uuid;
  v_email text := lower(trim(p_email));
  v_postcode text := nullif(upper(trim(coalesce(p_postcode, ''))), '');
begin
  -- Validate email format
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Please enter a valid email address.';
  end if;

  -- Validate postcode only if provided
  if v_postcode is not null and v_postcode !~ '^[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}$' then
    raise exception 'Please enter a valid UK postcode.';
  end if;

  -- Insert — skip if email already exists
  insert into public.coming_soon_signups (email, postcode, source)
  values (v_email, v_postcode, p_source)
  on conflict (email) do nothing
  returning id into v_new_id;

  -- No new row created → email already registered
  if v_new_id is null then
    return false;
  end if;

  -- Send confirmation email via Resend if API key exists
  select decrypted_secret into v_api_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_api_key is null then
    return true; -- Signup saved, email skipped
  end if;

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_api_key,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'from', 'Yo7 Foods <hello@yo7foods.co.uk>',
      'to', v_email,
      'subject', 'You''re on the list for Yo7 Foods',
      'html',
        '<div style="font-family:''Montserrat Alternates'',Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;">' ||
        '<h2 style="color:#063B00;">You''re on the list</h2>' ||
        '<p>Thanks for your interest in Yo7 Foods. We''re officially launching in Suffolk &amp; Essex in January 2027, bringing the premium African and Caribbean staples you love directly to East Anglia.</p>' ||
        '<p>We''ll email you the moment we launch, along with your 10% off code for your first order.</p>' ||
        '<p style="color:#999;font-size:12px;">Yo7 Foods &middot; 7 Lancaster Road, Ipswich, IP4 2NY</p>' ||
        '</div>',
      'text',
        'You''re on the list' || E'\n\n' ||
        'Thanks for your interest in Yo7 Foods. We''re officially launching in Suffolk & Essex in January 2027, bringing the premium African and Caribbean staples you love directly to East Anglia.' || E'\n\n' ||
        'We''ll email you the moment we launch, along with your 10% off code for your first order.' || E'\n\n' ||
        'Yo7 Foods · 7 Lancaster Road, Ipswich, IP4 2NY'
    )
  );

  return true;
end;
$_$;


ALTER FUNCTION "public"."register_coming_soon_interest"("p_email" "text", "p_postcode" "text", "p_source" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."send_due_subscription_reminders"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_api_key text;
  v_row record;
begin
  select decrypted_secret into v_api_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_api_key is null then
    return; -- Resend not configured yet, see setup-order-emails.md
  end if;

  for v_row in
    select r.*, p.email as customer_email
    from public.subscription_reminders r
    join public.profiles p on p.id = r.user_id
    where r.active = true and r.next_due_at <= now() and p.email is not null
  loop
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_api_key,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'from', 'Yo7 Foods <orders@yo7foods.co.uk>',
        'to', v_row.customer_email,
        'subject', 'Time to reorder your ' || v_row.product_name || '?',
        'html',
          '<div style="font-family:''Montserrat Alternates'',Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;">' ||
          '<h2 style="color:#063B00;">Running low on ' || v_row.product_name || '?</h2>' ||
          '<p>You subscribed to reorder this every ' || v_row.frequency_weeks || ' week' || (case when v_row.frequency_weeks = 1 then ''else 's' end) || ', and that time has come round again. Head back to Yo7 Foods whenever you''re ready — this is just a reminder, nothing''s been charged.</p>' ||
          '<p style="margin:24px 0;"><a href="https://yo7foods.co.uk/#/orders" style="background:#90B800;color:#063B00;font-weight:bold;text-decoration:none;padding:12px 28px;border-radius:8px;display:inline-block;">Reorder now</a></p>' ||
          '<p style="color:#999;font-size:12px;">Yo7 Foods &middot; 7 Lancaster Road, Ipswich, IP4 2NY<br>' ||
          '<a href="https://yo7foods.co.uk/#/unsubscribe-reminder/' || v_row.unsubscribe_token || '" style="color:#999;">Stop these reminders for this item</a></p>' ||
          '</div>',
        'text',
          'Running low on ' || v_row.product_name || '?' || E'\n\n' ||
          'You subscribed to reorder this every ' || v_row.frequency_weeks || ' week' || (case when v_row.frequency_weeks = 1 then '' else 's' end) || ', and that time has come round again. This is just a reminder, nothing''s been charged.' || E'\n\n' ||
          'Reorder now: https://yo7foods.co.uk/#/orders' || E'\n\n' ||
          'Stop these reminders for this item: https://yo7foods.co.uk/#/unsubscribe-reminder/' || v_row.unsubscribe_token || E'\n\n' ||
          'Yo7 Foods · 7 Lancaster Road, Ipswich, IP4 2NY'
      )
    );

    update public.subscription_reminders
    set next_due_at = now() + (frequency_weeks || ' weeks')::interval,
        last_sent_at = now(),
        updated_at = now()
    where id = v_row.id;
  end loop;
end;
$$;


ALTER FUNCTION "public"."send_due_subscription_reminders"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."send_order_status_email"("p_order_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_order public.orders%rowtype;
  v_email text;
  v_api_key text;
  v_copy record;
  v_note_html text;
  v_note_text text;
begin
  if not public.is_admin_user() then
    raise exception 'Not authorized';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'Order not found';
  end if;

  select email into v_email from public.profiles where id = v_order.user_id;
  if v_email is null then
    return; -- nothing to send to
  end if;

  select decrypted_secret into v_api_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_api_key is null then
    return; -- Resend not configured yet, see setup-order-emails.md
  end if;

  select * into v_copy from public.order_status_email_copy(v_order.status, v_order.cancellation_reason);

  -- The admin's optional comment (admin_note), shown alongside the status
  -- update. Cancellations already show their reason via cancellation_reason
  -- (baked into v_copy.body above), so this only adds a second paragraph
  -- for a non-cancelled status change.
  v_note_html := case
    when v_order.status <> 'cancelled' and v_order.admin_note is not null and length(trim(v_order.admin_note)) > 0
      then '<p>' || v_order.admin_note || '</p>'
    else ''
  end;
  v_note_text := case
    when v_order.status <> 'cancelled' and v_order.admin_note is not null and length(trim(v_order.admin_note)) > 0
      then v_order.admin_note || E'\n\n'
    else ''
  end;

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_api_key,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'from', 'Yo7 Foods <orders@yo7foods.co.uk>',
      'to', v_email,
      'subject', v_copy.subject || ' — ' || coalesce(v_order.order_number, v_order.id::text),
      'html',
        '<div style="font-family:''Montserrat Alternates'',Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;">' ||
        '<h2 style="color:#063B00;">' || v_copy.headline || '</h2>' ||
        '<p>' || v_copy.body || '</p>' ||
        v_note_html ||
        '<p style="color:#666;font-size:13px;">Order ' || coalesce(v_order.order_number, v_order.id::text) || ' &middot; Total ' || to_char(v_order.total, 'FM£999999990.00') || '</p>' ||
        '<p style="margin:24px 0;"><a href="https://yo7foods.co.uk/#/orders" style="background:#90B800;color:#063B00;font-weight:bold;text-decoration:none;padding:12px 28px;border-radius:8px;display:inline-block;">View your orders</a></p>' ||
        '<p style="color:#999;font-size:12px;">Yo7 Foods &middot; 7 Lancaster Road, Ipswich, IP4 2NY</p>' ||
        '</div>',
      'text',
        v_copy.headline || E'\n\n' || v_copy.body || E'\n\n' ||
        v_note_text ||
        'Order ' || coalesce(v_order.order_number, v_order.id::text) || ' · Total ' || to_char(v_order.total, 'FM£999999990.00') || E'\n' ||
        'View your orders: https://yo7foods.co.uk/#/orders' || E'\n\n' ||
        'Yo7 Foods · 7 Lancaster Road, Ipswich, IP4 2NY'
    )
  );
end;
$$;


ALTER FUNCTION "public"."send_order_status_email"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."subscribe_to_newsletter"("p_email" "text", "p_source" "text" DEFAULT 'footer'::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_api_key text;
  v_id uuid;
  v_token uuid;
begin
  if p_email is null or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Please enter a valid email address.';
  end if;

  -- Reactivates a previously unsubscribed row on the same email instead of
  -- the old on conflict do nothing, which would silently no-op the form —
  -- someone who unsubscribed and later re-signs-up via the footer form
  -- should actually end up resubscribed.
  insert into public.newsletter_subscribers (email, source, active)
  values (lower(trim(p_email)), p_source, true)
  on conflict (email) do update
    set active = true, subscribed_at = now(), source = excluded.source
    where newsletter_subscribers.active = false
  returning id, unsubscribe_token into v_id, v_token;

  if v_id is null then
    raise exception 'This email is already subscribed to our newsletter.';
  end if;

  select decrypted_secret into v_api_key from vault.decrypted_secrets where name = 'resend_api_key';
  if v_api_key is null then
    return; -- Resend not configured yet, the subscription itself is still saved
  end if;

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_api_key,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'from', 'Yo7 Foods <hello@yo7foods.co.uk>',
      'to', lower(trim(p_email)),
      'subject', 'Welcome to the Yo7 Family',
      'html',
        '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">' ||
        '<h2 style="color:#063B00;">You''re on the list</h2>' ||
        '<p>Thanks for joining the Yo7 Family. Expect new arrivals, offers, and the occasional recipe, no spam.</p>' ||
        '<p style="margin:24px 0;"><a href="https://yo7foods.co.uk/#/shop" style="background:#90B800;color:#063B00;font-weight:bold;text-decoration:none;padding:12px 28px;border-radius:8px;display:inline-block;">Start shopping</a></p>' ||
        '<p style="color:#999;font-size:12px;">Yo7 Foods &middot; 7 Lancaster Road, Ipswich, IP4 2NY<br>' ||
        '<a href="https://yo7foods.co.uk/#/unsubscribe-newsletter/' || v_token || '" style="color:#999;">Unsubscribe</a></p>' ||
        '</div>'
    )
  );
end;
$_$;


ALTER FUNCTION "public"."subscribe_to_newsletter"("p_email" "text", "p_source" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_subscription_reminders"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_item jsonb;
  v_freq int;
begin
  if new.user_id is null or new.items is null then
    return new;
  end if;

  for v_item in select * from jsonb_array_elements(new.items)
  loop
    if coalesce((v_item->>'isSubscription')::boolean, false) then
      v_freq := nullif(v_item->>'subscriptionFrequency', '')::int;
      if v_freq is null or v_freq <= 0 or v_item->>'id' is null then
        continue;
      end if;

      insert into public.subscription_reminders
        (user_id, order_id, product_key, product_name, frequency_weeks, next_due_at, active)
      values
        (new.user_id, new.id, v_item->>'id', coalesce(v_item->>'name', 'your item'), v_freq,
         now() + (v_freq || ' weeks')::interval, true)
      on conflict (user_id, product_key) where active
      do update set
        order_id = excluded.order_id,
        product_name = excluded.product_name,
        frequency_weeks = excluded.frequency_weeks,
        next_due_at = excluded.next_due_at,
        updated_at = now();
    end if;
  end loop;

  return new;
end;
$$;


ALTER FUNCTION "public"."sync_subscription_reminders"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unsubscribe_newsletter"("p_token" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update public.newsletter_subscribers
  set active = false
  where unsubscribe_token = p_token and active = true;

  return found;
end;
$$;


ALTER FUNCTION "public"."unsubscribe_newsletter"("p_token" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unsubscribe_reminder"("p_token" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_name text;
begin
  update public.subscription_reminders
  set active = false, updated_at = now()
  where unsubscribe_token = p_token and active = true
  returning product_name into v_name;

  return v_name; -- null if the token didn't match an active reminder
end;
$$;


ALTER FUNCTION "public"."unsubscribe_reminder"("p_token" "uuid") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."admin_audit_log" (
    "id" bigint NOT NULL,
    "admin_user_id" "uuid" NOT NULL,
    "admin_name" "text",
    "admin_email" "text",
    "action" "text" NOT NULL,
    "target_type" "text" NOT NULL,
    "target_label" "text",
    "details" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."admin_audit_log" OWNER TO "postgres";


ALTER TABLE "public"."admin_audit_log" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."admin_audit_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."advert_banners" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "image_url" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."advert_banners" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."carts" (
    "user_id" "uuid" NOT NULL,
    "items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."carts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."coming_soon_signups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "postcode" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text"
);


ALTER TABLE "public"."coming_soon_signups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."custom_products" (
    "cat_slug" "text" NOT NULL,
    "idx" integer NOT NULL,
    "name" "text" NOT NULL,
    "unit" "text" NOT NULL,
    "price" numeric NOT NULL,
    "sale_price" numeric,
    "weight" numeric,
    "stock" "text" DEFAULT 'in'::"text" NOT NULL,
    "description" "text",
    "image_url" "text",
    "is_new" boolean DEFAULT false NOT NULL,
    "is_best_seller" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."custom_products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."discount_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text",
    "type" "text" NOT NULL,
    "value" numeric,
    "buy_qty" integer,
    "get_qty" integer,
    "qualifying_scope" "text" DEFAULT 'all'::"text" NOT NULL,
    "qualifying_category" "text",
    "qualifying_product_id" "text",
    "min_order" numeric,
    "max_per_customer" integer,
    "start_date" "date",
    "end_date" "date",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "discount_codes_qualifying_scope_check" CHECK (("qualifying_scope" = ANY (ARRAY['all'::"text", 'category'::"text", 'product'::"text"]))),
    CONSTRAINT "discount_codes_type_check" CHECK (("type" = ANY (ARRAY['percent'::"text", 'fixed'::"text", 'bogo'::"text", 'freeDelivery'::"text"])))
);


ALTER TABLE "public"."discount_codes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."discount_redemptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "discount_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "guest_email" "text",
    "order_id" "uuid",
    "redeemed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."discount_redemptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."google_reviews_cache" (
    "id" boolean DEFAULT true NOT NULL,
    "rating" numeric,
    "review_count" integer,
    "reviews" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "fetched_at" timestamp with time zone,
    CONSTRAINT "google_reviews_cache_singleton" CHECK ("id")
);


ALTER TABLE "public"."google_reviews_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."loyalty_rewards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "code" "text",
    "pct" numeric NOT NULL,
    "used" boolean DEFAULT false NOT NULL,
    "earned_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "used_at" timestamp with time zone
);


ALTER TABLE "public"."loyalty_rewards" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."loyalty_settings" (
    "id" boolean DEFAULT true NOT NULL,
    "spend_threshold" numeric DEFAULT 100 NOT NULL,
    "reward_pct" numeric DEFAULT 10 NOT NULL,
    CONSTRAINT "loyalty_settings_singleton" CHECK ("id")
);


ALTER TABLE "public"."loyalty_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."newsletter_subscribers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "subscribed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text",
    "active" boolean DEFAULT true NOT NULL,
    "unsubscribe_token" "uuid" DEFAULT "gen_random_uuid"() NOT NULL
);


ALTER TABLE "public"."newsletter_subscribers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "order_number" "text",
    "status" "text" DEFAULT 'placed'::"text" NOT NULL,
    "items" "jsonb" NOT NULL,
    "subtotal" numeric(10,2) NOT NULL,
    "delivery_fee" numeric(10,2) DEFAULT 0 NOT NULL,
    "discount" numeric(10,2) DEFAULT 0 NOT NULL,
    "total" numeric(10,2) NOT NULL,
    "delivery_name" "text",
    "delivery_address" "text",
    "delivery_phone" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "fulfilment_method" "text" DEFAULT 'delivery'::"text",
    "cancellation_reason" "text",
    "admin_note" "text",
    "stripe_payment_intent_id" "text",
    "payment_method_summary" "text",
    "discount_id" "uuid",
    "discount_code" "text",
    "delivery_postcode" "text",
    CONSTRAINT "orders_fulfilment_method_check" CHECK (("fulfilment_method" = ANY (ARRAY['delivery'::"text", 'pickup'::"text"]))),
    CONSTRAINT "orders_status_check" CHECK (("status" = ANY (ARRAY['placed'::"text", 'being_prepared'::"text", 'out_for_delivery'::"text", 'ready_for_pickup'::"text", 'delivered'::"text", 'cancelled'::"text", 'returned'::"text"])))
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."orders_order_number_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."orders_order_number_seq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pending_checkouts" (
    "payment_intent_id" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "items" "jsonb" NOT NULL,
    "subtotal" numeric(10,2) NOT NULL,
    "delivery_fee" numeric(10,2) DEFAULT 0 NOT NULL,
    "discount" numeric(10,2) DEFAULT 0 NOT NULL,
    "total" numeric(10,2) NOT NULL,
    "fulfilment_method" "text" NOT NULL,
    "delivery_name" "text",
    "delivery_address" "text",
    "delivery_phone" "text",
    "notes" "text",
    "discount_id" "uuid",
    "discount_code" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pending_checkouts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pricing_settings" (
    "id" boolean DEFAULT true NOT NULL,
    "delivery_weight_tiers" "jsonb" NOT NULL,
    "delivery_threshold_rules" "jsonb" NOT NULL,
    "subscription_discount_pct" numeric DEFAULT 10 NOT NULL,
    "bundle_discounts" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "combo_discounts" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "trustpilot_url" "text",
    "google_business_url" "text",
    "bundles_data" "jsonb",
    "combos_data" "jsonb",
    "google_place_id" "text",
    "dish_templates_data" "jsonb",
    "category_overrides" "jsonb" DEFAULT '{}'::"jsonb",
    CONSTRAINT "pricing_settings_singleton" CHECK ("id")
);


ALTER TABLE "public"."pricing_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_overrides" (
    "product_key" "text" NOT NULL,
    "image_url" "text",
    "price" numeric,
    "sale_price" numeric,
    "stock" "text",
    "weight" numeric,
    "unit_override" "jsonb",
    "description" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "weight_variants" "jsonb",
    "is_new" boolean,
    "name" "text",
    "origin" "text",
    "storage" "text",
    "allergens" "text"[],
    "allergy_note" "text",
    "nutrition" "text",
    "cooking_tip" "text"
);


ALTER TABLE "public"."product_overrides" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_reviews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_key" "text" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "rating" smallint NOT NULL,
    "comment" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_anonymous" boolean DEFAULT false NOT NULL,
    "is_verified_purchase" boolean DEFAULT false NOT NULL,
    CONSTRAINT "product_reviews_rating_check" CHECK ((("rating" >= 1) AND ("rating" <= 5)))
);


ALTER TABLE "public"."product_reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."products" (
    "cat_slug" "text" NOT NULL,
    "idx" integer NOT NULL,
    "name" "text" NOT NULL,
    "unit" "text" NOT NULL,
    "weight" numeric,
    "price" numeric NOT NULL,
    "sale_price" numeric,
    "stock" "text" DEFAULT 'in'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "phone" "text",
    "is_admin" boolean DEFAULT false NOT NULL,
    "email" "text"
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rate_limit_hits" (
    "id" bigint NOT NULL,
    "bucket_key" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."rate_limit_hits" OWNER TO "postgres";


ALTER TABLE "public"."rate_limit_hits" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."rate_limit_hits_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."subscription_reminders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "order_id" "uuid",
    "product_key" "text" NOT NULL,
    "product_name" "text" NOT NULL,
    "frequency_weeks" integer NOT NULL,
    "next_due_at" timestamp with time zone NOT NULL,
    "last_sent_at" timestamp with time zone,
    "active" boolean DEFAULT true NOT NULL,
    "unsubscribe_token" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "subscription_reminders_frequency_weeks_check" CHECK (("frequency_weeks" > 0))
);


ALTER TABLE "public"."subscription_reminders" OWNER TO "postgres";


ALTER TABLE ONLY "public"."admin_audit_log"
    ADD CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."advert_banners"
    ADD CONSTRAINT "advert_banners_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."carts"
    ADD CONSTRAINT "carts_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."coming_soon_signups"
    ADD CONSTRAINT "coming_soon_signups_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."coming_soon_signups"
    ADD CONSTRAINT "coming_soon_signups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."custom_products"
    ADD CONSTRAINT "custom_products_pkey" PRIMARY KEY ("cat_slug", "idx");



ALTER TABLE ONLY "public"."discount_codes"
    ADD CONSTRAINT "discount_codes_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."discount_codes"
    ADD CONSTRAINT "discount_codes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."discount_redemptions"
    ADD CONSTRAINT "discount_redemptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."google_reviews_cache"
    ADD CONSTRAINT "google_reviews_cache_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."loyalty_rewards"
    ADD CONSTRAINT "loyalty_rewards_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."loyalty_rewards"
    ADD CONSTRAINT "loyalty_rewards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."loyalty_settings"
    ADD CONSTRAINT "loyalty_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."newsletter_subscribers"
    ADD CONSTRAINT "newsletter_subscribers_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."newsletter_subscribers"
    ADD CONSTRAINT "newsletter_subscribers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pending_checkouts"
    ADD CONSTRAINT "pending_checkouts_pkey" PRIMARY KEY ("payment_intent_id");



ALTER TABLE ONLY "public"."pricing_settings"
    ADD CONSTRAINT "pricing_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_overrides"
    ADD CONSTRAINT "product_overrides_pkey" PRIMARY KEY ("product_key");



ALTER TABLE ONLY "public"."product_reviews"
    ADD CONSTRAINT "product_reviews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."product_reviews"
    ADD CONSTRAINT "product_reviews_product_key_user_id_key" UNIQUE ("product_key", "user_id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("cat_slug", "idx");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."rate_limit_hits"
    ADD CONSTRAINT "rate_limit_hits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_reminders"
    ADD CONSTRAINT "subscription_reminders_pkey" PRIMARY KEY ("id");



CREATE INDEX "admin_audit_log_admin_user_id_idx" ON "public"."admin_audit_log" USING "btree" ("admin_user_id");



CREATE INDEX "admin_audit_log_created_at_idx" ON "public"."admin_audit_log" USING "btree" ("created_at" DESC);



CREATE INDEX "discount_redemptions_by_email" ON "public"."discount_redemptions" USING "btree" ("discount_id", "guest_email") WHERE ("guest_email" IS NOT NULL);



CREATE INDEX "discount_redemptions_by_user" ON "public"."discount_redemptions" USING "btree" ("discount_id", "user_id") WHERE ("user_id" IS NOT NULL);



CREATE UNIQUE INDEX "newsletter_subscribers_token_idx" ON "public"."newsletter_subscribers" USING "btree" ("unsubscribe_token");



CREATE UNIQUE INDEX "orders_stripe_payment_intent_id_key" ON "public"."orders" USING "btree" ("stripe_payment_intent_id") WHERE ("stripe_payment_intent_id" IS NOT NULL);



CREATE INDEX "rate_limit_hits_bucket_time_idx" ON "public"."rate_limit_hits" USING "btree" ("bucket_key", "created_at");



CREATE UNIQUE INDEX "subscription_reminders_active_user_product" ON "public"."subscription_reminders" USING "btree" ("user_id", "product_key") WHERE "active";



CREATE INDEX "subscription_reminders_due_idx" ON "public"."subscription_reminders" USING "btree" ("next_due_at") WHERE "active";



CREATE UNIQUE INDEX "subscription_reminders_token_idx" ON "public"."subscription_reminders" USING "btree" ("unsubscribe_token");



CREATE OR REPLACE TRIGGER "on_order_record_discount_redemption" AFTER INSERT ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."record_discount_redemption"();



CREATE OR REPLACE TRIGGER "orders_sync_subscription_reminders" AFTER INSERT ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."sync_subscription_reminders"();



CREATE OR REPLACE TRIGGER "profiles_prevent_self_admin_escalation" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_self_admin_escalation"();



CREATE OR REPLACE TRIGGER "trg_assign_order_number" BEFORE INSERT ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."assign_order_number"();



CREATE OR REPLACE TRIGGER "trg_notify_order_status_change" AFTER INSERT OR UPDATE ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."notify_order_status_change"();



ALTER TABLE ONLY "public"."admin_audit_log"
    ADD CONSTRAINT "admin_audit_log_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."carts"
    ADD CONSTRAINT "carts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."discount_redemptions"
    ADD CONSTRAINT "discount_redemptions_discount_id_fkey" FOREIGN KEY ("discount_id") REFERENCES "public"."discount_codes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."discount_redemptions"
    ADD CONSTRAINT "discount_redemptions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id");



ALTER TABLE ONLY "public"."discount_redemptions"
    ADD CONSTRAINT "discount_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."loyalty_rewards"
    ADD CONSTRAINT "loyalty_rewards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_discount_id_fkey" FOREIGN KEY ("discount_id") REFERENCES "public"."discount_codes"("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pending_checkouts"
    ADD CONSTRAINT "pending_checkouts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."product_reviews"
    ADD CONSTRAINT "product_reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscription_reminders"
    ADD CONSTRAINT "subscription_reminders_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."subscription_reminders"
    ADD CONSTRAINT "subscription_reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



CREATE POLICY "Admins can manage discount codes" ON "public"."discount_codes" USING ("public"."is_admin_user"()) WITH CHECK ("public"."is_admin_user"());



CREATE POLICY "Admins can manage pricing settings" ON "public"."pricing_settings" USING ("public"."is_admin_user"()) WITH CHECK ("public"."is_admin_user"());



CREATE POLICY "Admins can update all orders" ON "public"."orders" FOR UPDATE USING ("public"."is_admin_user"());



CREATE POLICY "Admins can update all profiles" ON "public"."profiles" FOR UPDATE USING ("public"."is_admin_user"());



CREATE POLICY "Admins can update loyalty settings" ON "public"."loyalty_settings" FOR UPDATE USING ("public"."is_admin_user"()) WITH CHECK ("public"."is_admin_user"());



CREATE POLICY "Admins can view all orders" ON "public"."orders" FOR SELECT USING ("public"."is_admin_user"());



CREATE POLICY "Admins can view all profiles" ON "public"."profiles" FOR SELECT USING ("public"."is_admin_user"());



CREATE POLICY "Admins can view all subscription reminders" ON "public"."subscription_reminders" FOR SELECT USING ("public"."is_admin_user"());



CREATE POLICY "Admins can view audit log" ON "public"."admin_audit_log" FOR SELECT USING ("public"."is_admin_user"());



CREATE POLICY "Admins can view coming soon signups" ON "public"."coming_soon_signups" FOR SELECT USING ("public"."is_admin_user"());



CREATE POLICY "Admins can view redemptions" ON "public"."discount_redemptions" FOR SELECT USING ("public"."is_admin_user"());



CREATE POLICY "Admins can view subscribers" ON "public"."newsletter_subscribers" FOR SELECT USING ("public"."is_admin_user"());



CREATE POLICY "Admins can write audit log" ON "public"."admin_audit_log" FOR INSERT WITH CHECK ("public"."is_admin_user"());



CREATE POLICY "Admins can write custom products" ON "public"."custom_products" USING ("public"."is_admin_user"()) WITH CHECK ("public"."is_admin_user"());



CREATE POLICY "Admins can write product overrides" ON "public"."product_overrides" USING ("public"."is_admin_user"()) WITH CHECK ("public"."is_admin_user"());



CREATE POLICY "Anyone can read cached google reviews" ON "public"."google_reviews_cache" FOR SELECT USING (true);



CREATE POLICY "Anyone can read loyalty settings" ON "public"."loyalty_settings" FOR SELECT USING (true);



CREATE POLICY "Anyone can register interest" ON "public"."coming_soon_signups" FOR INSERT WITH CHECK (true);



CREATE POLICY "Anyone can subscribe" ON "public"."newsletter_subscribers" FOR INSERT WITH CHECK (true);



CREATE POLICY "Anyone can view custom products" ON "public"."custom_products" FOR SELECT USING (true);



CREATE POLICY "Anyone can view pricing settings" ON "public"."pricing_settings" FOR SELECT USING (true);



CREATE POLICY "Anyone can view product overrides" ON "public"."product_overrides" FOR SELECT USING (true);



CREATE POLICY "Anyone can view products" ON "public"."products" FOR SELECT USING (true);



CREATE POLICY "Anyone can view reviews" ON "public"."product_reviews" FOR SELECT USING (true);



CREATE POLICY "Signed-in users can write their own review" ON "public"."product_reviews" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can create their own cart" ON "public"."carts" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete their own review, admins any" ON "public"."product_reviews" FOR DELETE USING ((("auth"."uid"() = "user_id") OR "public"."is_admin_user"()));



CREATE POLICY "Users can edit their own review" ON "public"."product_reviews" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert own orders" ON "public"."orders" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can update their own cart" ON "public"."carts" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own orders" ON "public"."orders" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view own profile" ON "public"."profiles" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can view their own cart" ON "public"."carts" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own loyalty rewards" ON "public"."loyalty_rewards" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own subscription reminders" ON "public"."subscription_reminders" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."admin_audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."advert_banners" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "advert_banners_admin_write" ON "public"."advert_banners" USING ("public"."is_admin_user"()) WITH CHECK ("public"."is_admin_user"());



CREATE POLICY "advert_banners_select_all" ON "public"."advert_banners" FOR SELECT USING (true);



ALTER TABLE "public"."carts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."coming_soon_signups" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."custom_products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."discount_codes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."discount_redemptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."google_reviews_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."loyalty_rewards" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."loyalty_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."newsletter_subscribers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pending_checkouts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pricing_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_overrides" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."product_reviews" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rate_limit_hits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subscription_reminders" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."orders";






GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."assign_order_number"() TO "anon";
GRANT ALL ON FUNCTION "public"."assign_order_number"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assign_order_number"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_best_sellers"("p_days" integer, "p_limit" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_best_sellers"("p_days" integer, "p_limit" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_best_sellers"("p_days" integer, "p_limit" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_units_sold"("p_product_keys" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."get_units_sold"("p_product_keys" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_units_sold"("p_product_keys" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."has_purchased_product"("p_user_id" "uuid", "p_product_key" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."has_purchased_product"("p_user_id" "uuid", "p_product_key" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_purchased_product"("p_user_id" "uuid", "p_product_key" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."issue_loyalty_reward_if_earned"("p_order_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."issue_loyalty_reward_if_earned"("p_order_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."issue_loyalty_reward_if_earned"("p_order_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."mark_loyalty_reward_used"() TO "anon";
GRANT ALL ON FUNCTION "public"."mark_loyalty_reward_used"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."mark_loyalty_reward_used"() TO "service_role";



GRANT ALL ON FUNCTION "public"."notify_order_status_change"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_order_status_change"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_order_status_change"() TO "service_role";



GRANT ALL ON FUNCTION "public"."order_status_email_copy"("p_status" "text", "p_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."order_status_email_copy"("p_status" "text", "p_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."order_status_email_copy"("p_status" "text", "p_reason" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."prevent_self_admin_escalation"() TO "anon";
GRANT ALL ON FUNCTION "public"."prevent_self_admin_escalation"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prevent_self_admin_escalation"() TO "service_role";



GRANT ALL ON FUNCTION "public"."prune_pending_checkouts"("older_than" interval) TO "anon";
GRANT ALL ON FUNCTION "public"."prune_pending_checkouts"("older_than" interval) TO "authenticated";
GRANT ALL ON FUNCTION "public"."prune_pending_checkouts"("older_than" interval) TO "service_role";



GRANT ALL ON FUNCTION "public"."prune_rate_limit_hits"("older_than" interval) TO "anon";
GRANT ALL ON FUNCTION "public"."prune_rate_limit_hits"("older_than" interval) TO "authenticated";
GRANT ALL ON FUNCTION "public"."prune_rate_limit_hits"("older_than" interval) TO "service_role";



GRANT ALL ON FUNCTION "public"."record_discount_redemption"() TO "anon";
GRANT ALL ON FUNCTION "public"."record_discount_redemption"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_discount_redemption"() TO "service_role";



GRANT ALL ON FUNCTION "public"."register_coming_soon_interest"("p_email" "text", "p_postcode" "text", "p_source" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."register_coming_soon_interest"("p_email" "text", "p_postcode" "text", "p_source" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."register_coming_soon_interest"("p_email" "text", "p_postcode" "text", "p_source" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."send_due_subscription_reminders"() TO "anon";
GRANT ALL ON FUNCTION "public"."send_due_subscription_reminders"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."send_due_subscription_reminders"() TO "service_role";



GRANT ALL ON FUNCTION "public"."send_order_status_email"("p_order_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."send_order_status_email"("p_order_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."send_order_status_email"("p_order_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."subscribe_to_newsletter"("p_email" "text", "p_source" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."subscribe_to_newsletter"("p_email" "text", "p_source" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."subscribe_to_newsletter"("p_email" "text", "p_source" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_subscription_reminders"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_subscription_reminders"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_subscription_reminders"() TO "service_role";



GRANT ALL ON FUNCTION "public"."unsubscribe_newsletter"("p_token" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."unsubscribe_newsletter"("p_token" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unsubscribe_newsletter"("p_token" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."unsubscribe_reminder"("p_token" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."unsubscribe_reminder"("p_token" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unsubscribe_reminder"("p_token" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."admin_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."admin_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_audit_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."admin_audit_log_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."admin_audit_log_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."admin_audit_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."advert_banners" TO "anon";
GRANT ALL ON TABLE "public"."advert_banners" TO "authenticated";
GRANT ALL ON TABLE "public"."advert_banners" TO "service_role";



GRANT ALL ON TABLE "public"."carts" TO "anon";
GRANT ALL ON TABLE "public"."carts" TO "authenticated";
GRANT ALL ON TABLE "public"."carts" TO "service_role";



GRANT ALL ON TABLE "public"."coming_soon_signups" TO "anon";
GRANT ALL ON TABLE "public"."coming_soon_signups" TO "authenticated";
GRANT ALL ON TABLE "public"."coming_soon_signups" TO "service_role";



GRANT ALL ON TABLE "public"."custom_products" TO "anon";
GRANT ALL ON TABLE "public"."custom_products" TO "authenticated";
GRANT ALL ON TABLE "public"."custom_products" TO "service_role";



GRANT ALL ON TABLE "public"."discount_codes" TO "anon";
GRANT ALL ON TABLE "public"."discount_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."discount_codes" TO "service_role";



GRANT ALL ON TABLE "public"."discount_redemptions" TO "anon";
GRANT ALL ON TABLE "public"."discount_redemptions" TO "authenticated";
GRANT ALL ON TABLE "public"."discount_redemptions" TO "service_role";



GRANT ALL ON TABLE "public"."google_reviews_cache" TO "anon";
GRANT ALL ON TABLE "public"."google_reviews_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."google_reviews_cache" TO "service_role";



GRANT ALL ON TABLE "public"."loyalty_rewards" TO "anon";
GRANT ALL ON TABLE "public"."loyalty_rewards" TO "authenticated";
GRANT ALL ON TABLE "public"."loyalty_rewards" TO "service_role";



GRANT ALL ON TABLE "public"."loyalty_settings" TO "anon";
GRANT ALL ON TABLE "public"."loyalty_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."loyalty_settings" TO "service_role";



GRANT ALL ON TABLE "public"."newsletter_subscribers" TO "anon";
GRANT ALL ON TABLE "public"."newsletter_subscribers" TO "authenticated";
GRANT ALL ON TABLE "public"."newsletter_subscribers" TO "service_role";



GRANT ALL ON TABLE "public"."orders" TO "anon";
GRANT ALL ON TABLE "public"."orders" TO "authenticated";
GRANT ALL ON TABLE "public"."orders" TO "service_role";



GRANT ALL ON SEQUENCE "public"."orders_order_number_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."orders_order_number_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."orders_order_number_seq" TO "service_role";



GRANT ALL ON TABLE "public"."pending_checkouts" TO "anon";
GRANT ALL ON TABLE "public"."pending_checkouts" TO "authenticated";
GRANT ALL ON TABLE "public"."pending_checkouts" TO "service_role";



GRANT ALL ON TABLE "public"."pricing_settings" TO "anon";
GRANT ALL ON TABLE "public"."pricing_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."pricing_settings" TO "service_role";



GRANT ALL ON TABLE "public"."product_overrides" TO "anon";
GRANT ALL ON TABLE "public"."product_overrides" TO "authenticated";
GRANT ALL ON TABLE "public"."product_overrides" TO "service_role";



GRANT ALL ON TABLE "public"."product_reviews" TO "anon";
GRANT ALL ON TABLE "public"."product_reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."product_reviews" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."rate_limit_hits" TO "anon";
GRANT ALL ON TABLE "public"."rate_limit_hits" TO "authenticated";
GRANT ALL ON TABLE "public"."rate_limit_hits" TO "service_role";



GRANT ALL ON SEQUENCE "public"."rate_limit_hits_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."rate_limit_hits_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."rate_limit_hits_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."subscription_reminders" TO "anon";
GRANT ALL ON TABLE "public"."subscription_reminders" TO "authenticated";
GRANT ALL ON TABLE "public"."subscription_reminders" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";
