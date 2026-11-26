# Build plan

The full plan lives in the "Maker Business Suite — Claude Code Build Plan" doc
(kept outside this repo). This file tracks where the build is against it.

| Phase | Scope                                                          | Status                       |
| ----- | -------------------------------------------------------------- | ---------------------------- |
| 0     | Accounts and app reviews (done by the owner, outside the repo) | In progress                  |
| 1     | Foundation and tenancy                                         | Built                        |
| 2     | Billing and plans                                              | Built, awaiting Stripe keys  |
| 3     | Connections hub                                                | Built, awaiting app keys     |
| 4     | Financial dashboard module                                     | Built, awaiting app keys     |
| 5     | Help desk module                                               | Built, awaiting email keys   |
| 6     | Bookings, then Social                                          | Built, awaiting app keys     |
| 7     | Claude customization layer                                     | Assistant built; MCP not yet |
| 8     | Hardening and launch                                           | Not started                  |

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

## Phase 5: Help desk module

Goal: one inbox for email with Shopify order context next to each ticket.

Done when:

- [ ] An email sent to the tenant's address becomes a ticket (parsing, the
      queue and filing are tested; needs a real Postmark inbound stream)
- [ ] Replies thread correctly (tested at the database level by reply key and
      by mail headers; needs a real round trip through a mail app)
- [ ] The order panel matches the sender's email (it queries orders by the
      contact's email; needs real synced orders)

To switch the help desk on for an environment: set `INBOUND_EMAIL_DOMAIN`,
`POSTMARK_INBOUND_SECRET`, `POSTMARK_SERVER_TOKEN` and `ANTHROPIC_API_KEY`
(see `.env.example`) on the web service, the first of them on the worker too,
and point Postmark's inbound webhook at `/api/webhooks/postmark`.

Open decisions and deferrals:

- Reply templates are stored in `configs`, not in a `reply_templates` table
  as the plan's data model listed, because rule 4 puts templates in configs.
- Email only: no attachments, no HTML rendering of customer mail, and
  Instagram and Facebook messages wait for the Meta review (Phase 6).
- Drafts use Claude Opus 5.5 at low effort, metered against the plan's
  monthly AI allowance with a hard stop at the limit. The 80% warning and
  credit top-ups come with the assistant (Phase 7).
- Anyone on the team can reply; there is no assignment yet.
- Starter's "one tool of your choice" now has its chooser on the Billing page.

## Phase 6: Bookings, then Social

### Bookings

Goal: workshops and appointments people can book and pay for online, with
the money going straight to the business.

Done when:

- [ ] A customer books and pays through the embed, and both sides get emails
      (holding seats, payment confirmation and the emails are tested against
      stand-ins; needs a run with a real connected Stripe account and Postmark)
- [x] Capacity is enforced (automated: `tests/db/bookings.test.ts` covers
      full sessions, holds that lapse, double-booked appointment times and
      late payments)

To switch bookings on for an environment: set `STRIPE_CONNECT_CLIENT_ID` and
`STRIPE_CONNECT_WEBHOOK_SECRET` (see `.env.example`) on the web service, and
make sure the worker has `STRIPE_SECRET_KEY` and `NEXT_PUBLIC_SITE_URL`. Free
bookings work without Stripe.

Open decisions and deferrals:

- Businesses connect an existing Stripe account through Stripe's OAuth
  screen (Connect, Standard). We take no cut of booking payments.
- Refunds are not automatic. Cancelling (by the customer or the business)
  frees the seats and sends emails; the business refunds from Stripe.
- Seats are held for 40 minutes while someone pays. A payment that arrives
  after the hold lapsed and the session filled is kept and flagged for the
  business rather than dropped.
- The embed is a script that adds a frame; it works in a Shopify "Custom
  liquid" section. A proper Shopify theme app block needs the Shopify app
  itself and waits for app review (Phase 8).
- Google Calendar sync is not built yet (`sessions.calendar_event_id` is
  ready for it). It needs Google's OAuth verification from Phase 0.
- One set of hours per weekday for appointments; no buffers between
  appointments, no blocked-out dates, and one shared calendar per workspace
  rather than per staff member.
- The booking form's extra questions are a `configs` entry (rule 4), edited
  as one question per line.
- The public form has a simple bot trap but no rate limiting; add it in
  Phase 8.

### Social

Goal: plan posts on a calendar and have them go out on time.

Done when:

- [ ] A scheduled post publishes to a test Page and Instagram account at the
      set time (the queue, the Meta calls and partial-failure handling are
      tested against stand-ins; needs a real Meta app and test accounts)
- [x] A failed post is surfaced and can be retried (it is retried twice on
      its own, then shown under "Didn't post", the owners are emailed, and it
      can be fixed and rescheduled; automated in `tests/db/social.test.ts`)

To switch social on for an environment: set `META_APP_ID` and
`META_APP_SECRET` (see `.env.example`) on the web service and the worker.
Drafts and the calendar work without them.

Open decisions and deferrals:

- Facebook Pages and Instagram business accounts only, one photo or text
  per post. Carousels, video, Reels and Stories came later (see
  docs/social-side-by-side.md). TikTok (videos) and LinkedIn (a company
  page or the person) came later still, each through our own app
  (docs/tiktok-linkedin.md); Pinterest is not built.
- When someone manages several Pages, the one with Instagram linked is
  connected; there is no Page chooser yet.
- The plan's `assets` table is `social_assets`, and scheduling lives on the
  post itself (`scheduled_for`) rather than in a separate `post_schedules`
  table. Recurring "usual posting times" are not built.
- Uploaded photos are public by address (unguessable, but not private),
  because Instagram has to fetch them.
- Caption drafts are metered against the same monthly AI allowance as help
  desk drafts.
- An approval step is built (Review, in Social's menu); a workspace switches
  "approve posts before they go out" on under Settings → Social & emails →
  Post review. It is off by default, so any member can still post.
- Likes, comments and reach are not pulled back in.

## Phase 7: Claude customization layer

Goal: an assistant inside the app that answers questions about the business
and reshapes the workspace on request, with a person approving every change.

Done when:

- [ ] "Add a wholesale vs retail chart to my dashboard" produces a preview
      and applies cleanly (the tools, validation, proposal and apply steps are
      tested with a stand-in model; needs a run with a real API key. Note the
      dashboard has no wholesale/retail split widget yet, so today the
      assistant can rearrange and retitle existing widgets, not invent one)
- [x] Rollback works (every change is versioned and can be put back;
      automated in `tests/db/assistant.test.ts`)
- [x] Hitting the credit cap blocks further AI calls gracefully (the
      assistant, reply drafts and caption drafts all stop with a plain message)

Open decisions and deferrals:

- The remote MCP server (Studio plan) is not built. It needs a decision on
  how outside tools sign in (per-workspace access keys or OAuth).
- Tools so far: list and read settings, propose a change, sales figures,
  search help desk conversations. Bookings and social have no lookup tools.
- The 80% warning shows in the assistant; reply and caption drafts only
  show the stop at 100%. Buying extra credits is not built.
- Conversations are not saved; the chat starts fresh on each visit.
  Proposals and the change history are saved.
- Any member can ask the assistant and file a suggestion; only owners and
  admins can apply one or put a setting back.

## The overhaul: eight tools in the house look

After Phase 7 the suite was rebuilt to follow the single-tenant apps it grew
out of, in the "Tuft Life" house style. Status of each tool:

| Tool      | What it does now                                                                                                                                                  | Waiting on a decision                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Home      | The day's to-do list: one line per tool, what needs someone first                                                                                                 |                                                                         |
| Messages  | Channels, direct messages, mentions, unread counts, heads-ups from other tools                                                                                    |                                                                         |
| Money     | Dashboards from Shopify and QuickBooks                                                                                                                            |                                                                         |
| Help desk | Three-pane inbox, assignment, priority, snooze, team notes, joining conversations, rules, reply variables, reports, shortcuts                                     | Chat widget; Instagram and Facebook messages; text messages             |
| Bookings  | Check-in, notes and tags, add/move/cancel a person, private and closed dates, weekly repeats, email everyone, editable emails with thank-you, calendar, customers | Text reminders; shared capacity across workshops                        |
| Social    | Photo library, projects, multi-photo posts, per-channel captions, content plan, draft the month, month review, link page                                          | More networks; slides; video and reels; email newsletters; post results |
| Stock     | Reorder suggestions by supplier, item health, purchase orders, checking deliveries in, adding them to the shop's count                                            | Daily out-of-stock history; payables                                    |
| Shipping  | To-send queue, part shipments, packing slips, tracking, holds, sent log, marking orders sent in the shop                                                          | Buying postage (needs a label provider)                                 |

Shopify permissions the newer tools use, on top of the read-only ones:
`write_inventory` and `read_locations` (Stock adds deliveries to the shop's
count) and `write_merchant_managed_fulfillment_orders` (Shipping marks orders
as sent). Each is optional: without it the tool works and the shop is updated
by hand. Shipping also needs the app to be allowed to read customer addresses.

Stock and Shipping are on the Growth and Studio plans and are not yet among
the tools a Starter workspace can choose.
