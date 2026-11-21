# Maker Business Suite

Multi-tenant app for small maker businesses. Phase 1 (this code) is the
foundation: sign-in, workspaces, team invites and an empty app shell. See
`docs/build-plan.md` for what comes next and `CLAUDE.md` for the rules the
codebase follows.

## Run it locally

Requires Node 22 and pnpm.

```sh
pnpm install
cp .env.example .env.local   # fill in the two Supabase values
pnpm dev
```

## Set up a Supabase project (once per environment)

1. Apply the migrations: `supabase link --project-ref <ref>` then `supabase db push`.
2. Authentication → URL Configuration: set the Site URL to the deployment's
   origin and add `<origin>/auth/callback` to the redirect URLs.
3. Authentication → Providers: turn on Google and add its client ID and secret.
4. Authentication → Emails → Magic Link: point the link at
   `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email&next={{ .RedirectTo }}`
   if you want sign-in links to work when opened on a different device than
   the one that asked for them. The default template works on the same device.
5. Copy the project URL and publishable key into the environment's variables.

## Deploy to Railway

`railway.toml` configures the web service (build, start, health check at
`/api/health`). Create a staging and a production environment and set the
variables from `.env.example` in each, with `NEXT_PUBLIC_SITE_URL` set to that
environment's public URL.

## Checks

```sh
pnpm lint && pnpm typecheck && pnpm test   # also run by CI on every PR
pnpm test:e2e                              # Playwright, signed-out flows
```

The database tests run the real migration files against an in-process
Postgres, so they need no Supabase project or Docker.
