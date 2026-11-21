# Build plan

The full plan lives in the "Maker Business Suite — Claude Code Build Plan" doc
(kept outside this repo). This file tracks where the build is against it.

| Phase | Scope                                                          | Status      |
| ----- | -------------------------------------------------------------- | ----------- |
| 0     | Accounts and app reviews (done by the owner, outside the repo) | In progress |
| 1     | Foundation and tenancy                                         | Built       |
| 2     | Billing and plans                                              | Not started |
| 3     | Connections hub                                                | Not started |
| 4     | Financial dashboard module                                     | Not started |
| 5     | Help desk module                                               | Not started |
| 6     | Bookings, then Social                                          | Not started |
| 7     | Claude customization layer                                     | Not started |
| 8     | Hardening and launch                                           | Not started |

## Phase 1: Foundation and tenancy

Goal: a deployed app where someone can sign up, create a workspace, invite a
teammate, and see an empty dashboard shell.

Done when:

- [x] Two test accounts in two workspaces can't see each other's data
      (automated: `tests/db/tenant-isolation.test.ts`)
- [ ] Invite flow works end to end on staging (covered at the database level
      by the same test file; needs a click-through against real Supabase Auth)
- [x] Staging URL is live: https://web-staging-11af7da6.up.railway.app
      (Railway project `maker-business-suite`, environment `staging`; Supabase
      project in the "Maker business suite" organization)

Deferred on purpose:

- `withTenant()` service-role helper and the `worker` service: nothing uses
  the service role until Phase 2's Stripe webhook, so they arrive with it.
- Changing a member's role or removing a member.
