# Stripe payment setup: test mode today, going live for real launch

This file is referenced from three places in the codebase (`src/index.html`
near `STRIPE_PUBLISHABLE_KEY`/`ORDERING_LIVE`, and the header comments of
`supabase/functions/create-payment-intent/index.ts` and
`supabase/functions/stripe-webhook/index.ts`) as the walkthrough for this
exact switch. It didn't exist yet, this is that file.

## Where things stand right now (pre-launch)

- `ORDERING_LIVE = true` in `src/index.html` — the real Stripe checkout flow
  is switched on for QA/testing purposes, ahead of the "Launching January
  2027" public launch.
- `STRIPE_PUBLISHABLE_KEY` in `src/index.html` is a `pk_test_...` key.
- The `create-payment-intent` and `stripe-webhook` Edge Functions both read a
  `STRIPE_SECRET_KEY` Supabase secret, currently set to the matching
  `sk_test_...` key.
- `stripe-webhook` also reads a `STRIPE_WEBHOOK_SECRET` Supabase secret, set
  to a `whsec_...` signing secret for a **test-mode** webhook endpoint.

Because all three (publishable key, secret key, webhook secret) are test-mode,
every "real" charge today runs through Stripe's test mode and never moves
real money, even with `ORDERING_LIVE` set to `true`. That's deliberate and
safe to leave as-is until launch day.

## What "going live" actually requires

All three of the following, together, not one or two of them:

1. **Swap the publishable key** — in `src/index.html`, replace
   `STRIPE_PUBLISHABLE_KEY`'s `pk_test_...` value with the matching
   `pk_live_...` key from the Stripe Dashboard (Developers -> API keys, with
   "Viewing test data" toggled off).

2. **Swap the Edge Function secret key** — run:
   ```
   supabase secrets set STRIPE_SECRET_KEY=sk_live_...
   ```
   using the live secret key from the same Stripe Dashboard page. This one
   secret is shared by both `create-payment-intent` and `stripe-webhook`.

3. **Create a live-mode webhook endpoint and swap its signing secret** — test
   and live mode each have their own separate webhook endpoints in Stripe,
   a test-mode webhook secret will not verify a live-mode event. In the
   Stripe Dashboard (with "Viewing test data" toggled **off** this time):
   Developers -> Webhooks -> Add endpoint
   - URL: `https://mcxfzfvhdtcjfyjmnamr.supabase.co/functions/v1/stripe-webhook`
   - Events to send: `payment_intent.succeeded`

   Copy the new endpoint's "Signing secret" and run:
   ```
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
   ```

Supabase secrets take effect on a function's next invocation, no redeploy
needed. `src/index.html`'s key swap needs the normal ship process: edit
`src/index.html`, run `python3 scripts/minify.py`, commit, and push to `main`
(Cloudflare Workers auto-deploys from there).

## After swapping: verify, don't assume

- Place one real low-value order end to end and confirm it actually appears
  in the Stripe Dashboard's **live** payments list, not test.
- Confirm the order lands in the `orders` table and the customer gets the
  confirmation email.
- Trigger the webhook path specifically: Stripe Dashboard -> Webhooks -> the
  live endpoint -> "Send test webhook" for `payment_intent.succeeded`, and
  confirm it returns 200 rather than the 500 this function deliberately
  returns when a secret is missing or the signature doesn't verify (see that
  function's own header comment for why 500 here is intentional).

## If something's wrong after swapping

A charge going through on the Stripe Dashboard but no order appearing (or
vice versa) almost always means one of the three secrets above was missed or
copy-pasted from the wrong (test vs. live) dashboard view — re-check all
three rather than assuming the integration itself broke.
