# Maker Business Suite

Multi-tenant SaaS for small maker businesses: financial dashboard, help desk,
bookings, social. Customers never manage developer accounts; all integrations
are OAuth apps owned by us.

## Current phase

Phases 0 to 7 are built. Now: the overhaul toward eight full tools in the
house look (Messages, Bookings, Help desk, Stock and Shipping are built; the
larger Social is next). See docs/build-plan.md.

## Stack

- Next.js (App Router), TypeScript strict, Tailwind, shadcn/ui
- Supabase: Postgres + Auth + Storage + Vault; migrations in supabase/migrations
- Railway: `web` and `worker` services; Trigger.dev for background jobs
- Stripe Billing/Checkout/Portal; Stripe Connect Standard for bookings payouts
- Anthropic API (tool use) for the in-app assistant
- Zod for every config schema; Vitest + Playwright for tests

## Non-negotiable rules

1. Every table has tenant_id (except tenants) and RLS enabled. Every new
   table ships with a cross-tenant test.
2. Service-role queries go through withTenant(tenantId, ...). Never query
   tenant data without an explicit tenantId.
3. OAuth tokens live only in Supabase Vault and are read only via
   getProviderToken(tenantId, provider). Never log or return them.
4. Customization is data: dashboards, forms, templates and automations are
   Zod-validated JSON in `configs`. Never add per-customer code paths.
5. The AI assistant acts only through registered tools. All writes go
   propose -> preview -> apply and create a config_versions row.
6. AI drafts never auto-send to end customers.
7. All feature gating goes through lib/entitlements.ts.
8. Webhooks: verify signatures, make handlers idempotent, process on the
   worker, not in the request.
9. Integrations implement the ProviderAdapter interface
   (connect, refresh, disconnect, sync).

## Commands

- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm lint` (ESLint + Prettier check), `pnpm format` (Prettier write)
- `pnpm typecheck`
- `pnpm test` — Vitest. `tests/db` runs the real migration files against an
  in-process Postgres (PGlite) and holds the cross-tenant tests.
- `pnpm test:e2e` — Playwright (signed-out flows; builds the app first)
- `pnpm worker` — background worker (Stripe events, syncs, inbound email,
  booking payments and reminders, retention)
- `pnpm stripe:setup` — create/update Stripe products, prices and portal

## Things that are easy to get wrong here

- This is Next.js 16: read AGENTS.md and the docs in
  `node_modules/next/dist/docs/` before using a Next API from memory.
  Middleware is `src/proxy.ts`. Cache Components is on, so anything that reads
  the session renders at request time via `createClient()` in
  `lib/supabase/server.ts`.
- Clients have no direct insert/delete grants on tenancy tables. Writes that
  cross a trust boundary are SECURITY DEFINER functions in a migration
  (`create_tenant`, `create_invite`, `accept_invite`, ...), each checking the
  caller's role itself. New tables: revoke the default grants, then grant
  only what is needed (see the first migration).
- Billing: Stripe is the source of truth. The webhook only verifies and
  queues (`private.stripe_events`); `pnpm worker` applies events by re-reading
  the subscription from Stripe, so replays and out-of-order events are
  harmless. Only the worker writes `subscriptions`. Plans live in
  `lib/billing/plans.ts`; every gate asks `getEntitlements()`.
- Service-role code (`lib/supabase/admin.ts`) is server-only and touches
  tenant data only through `withTenant`.
- Connections: each provider is a `ProviderAdapter` in
  `lib/connections/providers/`, registered in `registry.ts`. Tokens are read
  only through `getProviderToken()` (it refreshes under a per-connection lock
  because refresh tokens rotate). Webhooks verify the signature on the raw
  body, queue a `sync_jobs` row and return; the worker runs the job.
- Money view: dashboards are JSON in `configs` (module `dashboard`), parsed
  with the Zod schemas in `lib/dashboard/schema.ts` on every read. Sync writes
  go through service-role functions that name the workspace
  (`upsert_commerce_batch`, ...); dashboard queries run as the member under
  RLS. Chart text is formatted on the server (`prepareTimeChart`) so server
  and browser output match. Charts follow one validated series colour
  (`--chart-1`) and always offer a table view.
- Help desk: inbound email is authenticated by a secret in the webhook URL,
  queued (`private.inbound_emails`) and filed by the worker through
  `ingest_inbound_email`, which threads by the ticket's reply key, then by
  mail headers. `tickets.reply_key` is never readable by clients. Customer
  email is shown as plain text only. Reply templates and auto-tag rules are
  `configs` (module `helpdesk`). Claude drafts go into the reply box and are
  never sent automatically; customer text in the prompt is marked as data.
  The inbox is one full-window page (`w/[slug]/helpdesk/page.tsx`) whose
  whole state is in the URL (`view`, `tag`, `q`, `t`); folders are worked out
  by `inView()` in `lib/helpdesk/views.ts`, so a snooze needs no timer. Notes
  for the team live in `ticket_notes` and are never emailed. A conversation
  joined into another keeps a `merged_into` pointer, and later mail follows
  it. Rules (`auto_tag_rules`) can tag, set priority or hand off; the worker
  applies the last two through `apply_ticket_rules` after filing.
- Bookings: seats are never stored as a count. `hold_booking`,
  `confirm_booking` and friends work them out from `bookings` under a row
  lock on the session. A paid booking is never dropped: paid late into a full
  session, it is confirmed and flagged `oversold`. The public pages (`/book`,
  `/booking`) have no database access of their own; they call service-role
  functions in `lib/bookings/server.ts` that name the workspace. Payments are
  direct charges on the business's own Stripe account (provider `stripe`);
  a Checkout session only counts if it sits on the account the workspace
  connected and is the one we created for that booking (`payments.ts`).
  Appointment times come from weekly hours in the workspace's timezone
  (`slots.ts`); keep the daylight-saving tests passing. What the business
  does by hand (add, move or cancel a person, close or hide a date, repeat
  weekly) is manager-only functions; check-in and notes are open to the
  whole team. A closed or private date refuses online bookings in a trigger,
  so no route can slip past it. Reminder and thank-you timing lives in
  `configs` (bookings / emails) and is read by `claim_booking_emails` in the
  database; the worker only adds the words. Tools with several views use
  `<SectionTabs>` under the page header.
- Social: members write posts through `save_social_post`; the worker claims
  due posts (`claim_due_social_posts`) and records each channel's answer with
  `finish_social_post`, which merges results so a channel that went out is
  never sent twice. A post that is partly or fully out can't be edited.
  Photos sit in the public `social` storage bucket under the workspace's id
  (Instagram fetches by URL); only the server uploads. Caption drafts land
  in the caption box and are never scheduled or posted automatically.
- Stock: `stock_items` mirror the shop's variants and are written only by
  the sync (`upsert_stock_items`), which leaves the workspace's own planning
  columns alone. Every reorder figure is worked out on read by the pure
  engine in `lib/stock/engine` (ported from TuftStock with its tests; change
  a formula only with its test) through `buildStockRows()`; nothing derived
  is stored. Sales are matched to an item by SKU, else by product and option.
  A sync only ever reads the shop's count. The one write to a shop is adding
  a checked-in delivery (`stock_receipts` -> worker -> `shopify-stock.ts`):
  add-only, tried once, and refused when the shop has more than one
  location. Suppliers and orders are manager-only; anyone on the team can
  check a delivery in. Supabase returns 1,000 rows at most, so `loadStock()`
  pages.
- Shipping: `shipping_orders` holds what packing needs (address, what's left
  to send), kept apart from `orders` so the sales figures never carry an
  address. It is read from the shop in a separate query that is allowed to
  fail, so a shop that hasn't shared addresses still syncs its sales. When a
  shopper is forgotten or a shop disconnected, triggers blank the address
  there and on `shipments`; keep both tests in `tests/db/shipping.test.ts`
  passing. A parcel is recorded with `record_shipment` (whole team; part
  shipments leave the rest in the queue); undoing one is manager-only. We do
  not buy postage: no label provider has been chosen. Telling the shop a
  parcel went (`shopify-fulfil.ts`) follows the same once-only queue as
  stock receipts.
- Code with no signed-in member (public pages, the worker) asks
  `moduleOpen()` in `lib/module-access.ts`, which uses the same resolver as
  `getEntitlements()`.
- Assistant: its whole reach is the tool list in `lib/assistant/tools.ts`,
  run with the member's own database session (never the service role). Its
  only write is `propose_config_change`, which validates against the Zod
  schema in `lib/assistant/registry.ts` and files a `config_proposals` row; a
  person previews it and an owner or admin applies it. Every config write,
  by hand or applied, goes through `private.write_config` and leaves a
  `config_versions` row. A new customisable setting means a registry entry.
  Earlier chat turns are sent as quoted text, so each request is a fresh,
  append-only conversation. Files marked "use server" export only actions.
- Messages: channels are open to the whole workspace, direct messages only
  to their two people (`private.can_see_chat`). All writes are functions
  (`post_chat_message`, ...); only the author can edit or delete, and delete
  keeps the row. The browser uses Supabase Realtime only as a nudge to
  re-read through server actions, with a 20s poll as a fallback, so nothing
  depends on the live payload. Message text is rendered as text nodes and
  plain links, never as markup (`splitBody`). Other tools post heads-ups with
  `postAlert()`, which must never throw. Pages that need the whole window
  live beside the `(app)` route group, not inside it.
- Schema changes are new files in `supabase/migrations`; never edit an
  applied migration.
- Look: the "Tuft Life" house style (see the tuft-ui repo's DESIGN.md). Teal
  rail with the dot texture, white cards on a warm panel, stone hairlines.
  Tokens live in `src/app/globals.css` as `--tuft-*` and as Tailwind colours
  (`bg-teal`, `text-ochre-text`, `bg-brick-soft`, ...). One filled ochre
  button per screen; other actions are `outline`, `dark` or `ghost`. Status
  uses `<Badge tone>` (open teal, waiting ochre, good mint, bad brick, closed
  sunken) and always carries words. Chivo for interface text, Roboto
  (`font-read`) for anything a customer wrote or will read, Abril Fatface
  (`font-display`) for the wordmark only. Pages start with `<PageHeader>`.
  On phones the rail becomes a bottom tab bar.
- UI copy: warm and plain, written for makers, not developers.

## Workflow

- Use plan mode before each phase step; commit after each step.
- Run `pnpm lint && pnpm typecheck && pnpm test` before every commit.
- Ask before adding a new paid service or dependency.
- Secrets come from .env.local (never committed); list new env vars in
  .env.example.

## Reference code

Patterns may be ported from Tim's single-tenant TTW apps (help desk,
booking app, social poster, dashboards) when he provides them, but must be
made multi-tenant under the rules above.
