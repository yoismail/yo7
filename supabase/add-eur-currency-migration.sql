-- Run this once in the Supabase SQL editor for the live yo7 project.
-- Adds EUR as a chargeable/displayable currency alongside GBP/CAD/USD/NGN:
-- widens the two charged_currency CHECK constraints that would otherwise
-- reject a EUR order/pending checkout, and teaches format_charged_amount()
-- (used by the order confirmation/status-change emails) the € symbol
-- instead of silently falling back to £ for a EUR-charged order.
--
-- Safe to run more than once: DROP CONSTRAINT IF EXISTS + CREATE OR REPLACE.

ALTER TABLE "public"."orders" DROP CONSTRAINT IF EXISTS "orders_charged_currency_check";
ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_charged_currency_check"
    CHECK (("charged_currency" = ANY (ARRAY['GBP'::"text", 'CAD'::"text", 'USD'::"text", 'NGN'::"text", 'EUR'::"text"])));

ALTER TABLE "public"."pending_checkouts" DROP CONSTRAINT IF EXISTS "pending_checkouts_charged_currency_check";
ALTER TABLE "public"."pending_checkouts" ADD CONSTRAINT "pending_checkouts_charged_currency_check"
    CHECK (("charged_currency" = ANY (ARRAY['GBP'::"text", 'CAD'::"text", 'USD'::"text", 'NGN'::"text", 'EUR'::"text"])));

CREATE OR REPLACE FUNCTION "public"."format_charged_amount"("p_currency" "text", "p_amount" numeric) RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
begin
  return (case p_currency
    when 'CAD' then 'CA$'
    when 'USD' then 'US$'
    when 'NGN' then '₦'
    when 'EUR' then '€'
    else '£'
  end) || to_char(coalesce(p_amount, 0), 'FM999,999,990.00');
end;
$$;
