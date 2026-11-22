# Maker Business Suite

Multi-tenant SaaS for small maker businesses: financial dashboard, help desk,
bookings, social. Customers never manage developer accounts; all integrations
are OAuth apps owned by us.

## Current phase

Phase 5: Help desk module (see docs/build-plan.md)

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
- `pnpm worker` — background worker (Stripe events, retention)
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
