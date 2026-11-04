-- Run this once in the Supabase SQL editor for the live yo7 project.
-- Fixes send_due_subscription_reminders(): the "Reorder now" button in
-- the reorder reminder email linked to #/orders instead of the actual
-- product page, so a customer clicking it landed on their order history
-- with no way to add the item to their cart. Now links to
-- #/product/<catSlug>/<idx>, same pattern already used by the restock
-- notification (see handle_stock_restock()'s own '#/product/' ||
-- replace(product_key, '::', '/') in schema.sql).
--
-- Safe to run more than once: CREATE OR REPLACE.

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
    return;
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
        'from', 'YO7 Foods <orders@yo7foods.co.uk>',
        'reply_to', 'hello@yo7foods.co.uk',
        'to', v_row.customer_email,
        'subject', 'Time to reorder your ' || v_row.product_name || '?',
        'html',
          '<div style="font-family:''Montserrat Alternates'',Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;">' ||
          '<div style="text-align:center;margin-bottom:14px;"><img src="https://yo7foods.co.uk/apple-touch-icon.png" width="52" height="52" alt="YO7 Foods" style="display:block;margin:0 auto;border-radius:50%;"></div>' ||
          '<h2 style="color:#063B00;">Running low on ' || v_row.product_name || '?</h2>' ||
          '<p>You subscribed to reorder this every ' || v_row.frequency_weeks || ' week' || (case when v_row.frequency_weeks = 1 then '' else 's' end) || ', and that time has come round again. Head back to YO7 Foods whenever you''re ready, this is just a reminder, nothing''s been charged.</p>' ||
          '<p style="margin:24px 0;"><a href="https://yo7foods.co.uk/#/product/' || replace(v_row.product_key, '::', '/') || '" style="background:#90B800;color:#063B00;font-weight:bold;text-decoration:none;padding:12px 28px;border-radius:8px;display:inline-block;">Reorder now</a></p>' ||
          '<p style="color:#666;font-size:12.5px;">Any questions? <a href="https://wa.me/447398810052" style="color:#90B800;font-weight:600;text-decoration:underline;">Chat with us on WhatsApp</a></p>' ||
          '<p style="color:#999;font-size:12px;">YO7 Foods &middot; 7 Lancaster Road, Ipswich, IP4 2NY<br>' ||
          '<a href="https://yo7foods.co.uk/#/unsubscribe-reminder/' || v_row.unsubscribe_token || '" style="color:#999;">Stop these reminders for this item</a></p>' ||
          '</div>',
        'text',
          'Running low on ' || v_row.product_name || '?' || E'\n\n' ||
          'You subscribed to reorder this every ' || v_row.frequency_weeks || ' week' || (case when v_row.frequency_weeks = 1 then '' else 's' end) || '. This is just a reminder, nothing''s been charged.' || E'\n\n' ||
          'Reorder now: https://yo7foods.co.uk/#/product/' || replace(v_row.product_key, '::', '/') || E'\n\n' ||
          'Any questions? Chat with us on WhatsApp: 07398 810052 (https://wa.me/447398810052)' || E'\n\n' ||
          'Stop these reminders: https://yo7foods.co.uk/#/unsubscribe-reminder/' || v_row.unsubscribe_token || E'\n\n' ||
          'YO7 Foods · 7 Lancaster Road, Ipswich, IP4 2NY'
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
