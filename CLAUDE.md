# Maker Business Suite

Multi-tenant SaaS for small maker businesses: financial dashboard, help desk,
bookings, social. Customers never manage developer accounts; all integrations
are OAuth apps owned by us.

## Current phase

Phase 1: Foundation and tenancy (see docs/build-plan.md)

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
