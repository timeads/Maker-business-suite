# Maker Business Suite

Multi-tenant SaaS for small maker businesses: financial dashboard, help desk,
bookings, social. Customers never manage developer accounts; all integrations
are OAuth apps owned by us.

## Current phase

Phase 7: Claude customization layer (see docs/build-plan.md)

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
  (`slots.ts`); keep the daylight-saving tests passing.
- Social: members write posts through `save_social_post`; the worker claims
  due posts (`claim_due_social_posts`) and records each channel's answer with
  `finish_social_post`, which merges results so a channel that went out is
  never sent twice. A post that is partly or fully out can't be edited.
  Photos sit in the public `social` storage bucket under the workspace's id
  (Instagram fetches by URL); only the server uploads. Caption drafts land
  in the caption box and are never scheduled or posted automatically.
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
- Schema changes are new files in `supabase/migrations`; never edit an
  applied migration.
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
