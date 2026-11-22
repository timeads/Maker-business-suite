# Build plan

The full plan lives in the "Maker Business Suite — Claude Code Build Plan" doc
(kept outside this repo). This file tracks where the build is against it.

| Phase | Scope                                                          | Status                      |
| ----- | -------------------------------------------------------------- | --------------------------- |
| 0     | Accounts and app reviews (done by the owner, outside the repo) | In progress                 |
| 1     | Foundation and tenancy                                         | Built                       |
| 2     | Billing and plans                                              | Built, awaiting Stripe keys |
| 3     | Connections hub                                                | Not started                 |
| 4     | Financial dashboard module                                     | Not started                 |
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

1. `STRIPE_SECRET_KEY=sk_test_... pnpm stripe:setup` (products, prices, portal)
2. In Stripe, add a webhook endpoint at `<site>/api/webhooks/stripe` for
   `checkout.session.completed` and `customer.subscription.*`
3. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `SUPABASE_SECRET_KEY`
   on the web service
4. Create the worker service from `railway.worker.toml` with
   `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `STRIPE_SECRET_KEY`

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
