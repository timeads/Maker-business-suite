# Build plan

The full plan lives in the "Maker Business Suite — Claude Code Build Plan" doc
(kept outside this repo). This file tracks where the build is against it.

| Phase | Scope                                                          | Status                      |
| ----- | -------------------------------------------------------------- | --------------------------- |
| 0     | Accounts and app reviews (done by the owner, outside the repo) | In progress                 |
| 1     | Foundation and tenancy                                         | Built                       |
| 2     | Billing and plans                                              | Built, awaiting Stripe keys |
| 3     | Connections hub                                                | Built, awaiting app keys    |
| 4     | Financial dashboard module                                     | Built, awaiting app keys    |
| 5     | Help desk module                                               | Not started                 |
| 6     | Bookings, then Social                                          | Not started                 |
| 7     | Claude customization layer                                     | Not started                 |
| 8     | Hardening and launch                                           | Not started                 |

## Phase 1: Foundation and tenancy

Goal: a deployed app where someone can sign up, create a workspace, invite a
teammate, and see an empty dashboard shell.

Done when:

- [x] Two test accounts in two workspaces can't see each other's data
      (automated: `tests/db/tenant-isolation.test.ts`)
- [x] Invite flow works end to end on staging (clicked through on 2026-11-21:
      invited by one account, joined from another)
- [x] Staging URL is live: https://web-staging-11af7da6.up.railway.app
      (Railway project `maker-business-suite`, environment `staging`; Supabase
      project in the "Maker business suite" organization)

Deferred on purpose:

- `withTenant()` service-role helper and the `worker` service: nothing uses
  the service role until Phase 2's Stripe webhook, so they arrive with it.
- Changing a member's role or removing a member.

## Phase 2: Billing and plans

Goal: a business can pick a plan, pay, manage its card, and lose access
cleanly if it cancels.

Done when:

- [ ] Trial → paid → upgrade → cancel all work with Stripe test cards
      (covered by `src/lib/billing/sync.test.ts` against a stand-in Stripe;
      needs a run with real test-mode keys)
- [x] Webhook replays don't double-apply (automated: the event queue test in
      `tests/db/billing.test.ts` and the replay tests in `sync.test.ts`)

To switch billing on for an environment:

1. Set `STRIPE_SECRET_KEY` and `SUPABASE_SECRET_KEY` on the web service
2. Run the worker service (start command `pnpm worker`) with
   `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `STRIPE_SECRET_KEY`.
   On start it creates the products, prices and portal settings in Stripe.
3. In Stripe, add a webhook endpoint at `<site>/api/webhooks/stripe` for
   `checkout.session.completed` and `customer.subscription.*`, and set its
   signing secret as `STRIPE_WEBHOOK_SECRET` on the web service

Open decisions and deferrals:

- Prices ($49 / $99 / $199) and AI allowances in `lib/billing/plans.ts` are
  placeholders.
- Stripe Tax is not switched on in Checkout yet.
- Deleting data 30 days after a plan ends is built but off until
  `ENABLE_TENANT_PURGE=true` is set on the worker.
- Starter's "one tool of your choice" is stored (`selected_modules`) and
  honoured by the gates, but the screen for choosing arrives with the first
  module.
- `usage_events` exists; nothing writes to it until the AI assistant (Phase 7).

## Phase 3: Connections hub

Goal: a Connections page with a Connect button per provider, live status, and
reconnect when a token expires.

Done when:

- [ ] A dev store and a QuickBooks sandbox connect, sync, disconnect and
      reconnect from the UI (the adapters are tested against scripted
      responses in `src/lib/connections/**/*.test.ts`; needs a run with real
      app credentials)
- [ ] Uninstalling the Shopify app marks the connection inactive (covered by
      the webhook, runner and database tests; needs the same real run)

To switch a provider on for an environment: set its client id and secret
(see `.env.example`) plus `SUPABASE_SECRET_KEY` on the web service and the
worker, and allow the redirect URL named there in the provider's app settings.

Open decisions and deferrals:

- Syncs prove the connection and refresh the account's name; storing orders,
  customers and reports arrives with the money view (Phase 4). Shopify order
  and customer webhooks are received and acknowledged but not stored yet.
- Shopify's privacy webhooks are accepted and verified. `shop/redact`
  disconnects the store; `customers/redact` and `customers/data_request` have
  nothing to act on until Phase 4 stores customer data, and must be handled
  there.
- Installing from the Shopify App Store (starting in Shopify rather than in a
  workspace) is Phase 8.
- Owners are emailed when a connection needs reconnecting only once Postmark
  is configured.

## Phase 4: Financial dashboard module

Goal: a useful money view in the first five minutes after connecting.

Done when:

- [ ] A new tenant connects Shopify + QuickBooks and sees populated widgets
      without any setup (the default layout needs no setup and the syncs and
      queries are tested; needs a run with real app credentials)
- [x] Changing a widget config in the database changes the chart (the page
      reads `configs` and validates it on every load)

Open decisions and deferrals:

- One date range applies to the whole dashboard (a row of presets above the
  charts) rather than a range per widget, so every number on the page agrees.
- Shopify only returns the last 60 days of orders unless the app is approved
  for `read_all_orders`; once approved, add it to `SHOPIFY_EXTRA_SCOPES`.
  Customer names and emails also need Shopify's protected customer data
  approval for a public app.
- QuickBooks report parsing is written from the documented report format and
  tested against hand-built samples, not yet against a live company.
- Money is shown in the workspace's currency; orders in other currencies are
  not converted.
- Customers and products are stored when they appear on an order.
- A customer data request emails the workspace owners rather than producing
  an export; review before Shopify's app review (Phase 8).
