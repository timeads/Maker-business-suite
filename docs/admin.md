# Platform admin

A private area at `/admin` for the people who run the suite. It is separate
from any workspace role: being an owner of a workspace gives no access, and a
platform admin doesn't need to belong to any workspace.

## Making someone a platform admin

There is no screen for this on purpose. Admins are rows in
`private.platform_admins`, added by hand in the Supabase SQL editor by
whoever operates the database.

1. The person signs in to the suite once, so they have an account.
2. Find their user id by email:

   ```sql
   select id, email, created_at from auth.users where email = 'person@example.com';
   ```

3. Add them, by id:

   ```sql
   insert into private.platform_admins (user_id, note)
   values ('00000000-0000-0000-0000-000000000000', 'Tim, owner');
   ```

To see who is one, and to take someone off:

```sql
select a.user_id, u.email, a.added_at, a.note
from private.platform_admins a join auth.users u on u.id = a.user_id;

delete from private.platform_admins where user_id = '00000000-0000-0000-0000-000000000000';
```

Once added, an "Admin" link shows in the workspace menu (the business's name,
top left; under "More" on a phone), for that person only. Or go straight to
`/admin`.

## How everyone else is kept out

- Signed out: the proxy sends `/admin` to sign-in, like the rest of the app.
- Signed in but not an admin: the pages answer "not found", the same page any
  wrong address gets, so the area doesn't announce itself.
- Underneath both: the pages have no database access of their own. They call
  `admin_*` database functions with the signed-in person's own session (never
  the service role), and each function checks `private.is_platform_admin()`
  itself and refuses with `42501`. The tables behind them
  (`private.platform_admins`, `private.admin_audit`, `public.plan_grants`)
  can't be read or written by any client.

## What admins can see

Only how a workspace is running:

- name, web address, when it was made, its people (email, role, joined);
- plan and billing state, including the Stripe customer and subscription ids
  to copy into Stripe's dashboard;
- connected services, each with a health word (active, needs reconnect, last
  sync failed), last good sync, and the last error as stored;
- the last 30 background jobs (type, status, error, when);
- how many orders, help desk conversations, bookings, posts, stock items and
  parcels it holds: counts only;
- AI use this month against the plan's allowance;
- what its plan lets it use today, worked out by the same resolver the
  workspace itself goes through (`lib/entitlements.ts`);
- the record of what admins have done to it.

Across the top of the list: totals (workspaces, trialing, paying, past due,
internal plans), failed jobs in the last 24 hours, connections needing a
reconnect, jobs due for over an hour and still not picked up, and Stripe
events and inbound emails that have waited more than ten minutes.

## What admins cannot see

Anything a workspace's customers wrote or bought: order contents, shopper
names, addresses, ticket and message text. Nor tokens, job payloads, or the
account name on a connection. The functions simply don't return them, and
`tests/db/platform-admin.test.ts` pins the exact list of fields.

One caveat: error text on connections and jobs is shown as it was stored. It
comes from the provider or our own sync code, and is meant to be read by us.

## What admins can do

Two things, each written to the record with who, when and why:

- **Give an internal plan** (below).
- **Ask for a fresh sync** of one connection. This calls the same
  `enqueue_sync` the app uses, so it queues nothing if a sync is already
  waiting or the connection isn't active.

## Internal plan grants

A grant gives a workspace one of the ordinary plans without Stripe: our own
business, a thank-you, a longer try-out. It has a plan, an optional end date
and a note saying why (required).

- While it runs, the workspace behaves as that plan and can make changes,
  whatever its Stripe subscription says: no subscription, past due, or ended.
- When the end date passes, or an admin ends it early, the workspace goes
  back to whatever Stripe says. Nothing needs to run for this to happen: it
  is worked out on read.
- A grant never touches `subscriptions`. Stripe stays the source of truth for
  real subscriptions; a grant only sits in front of it for a while.
- The workspace's Billing page says "This workspace is on an internal plan,
  set up by us" and offers no checkout while it runs.
- A workspace on a running grant is never purged, even if an old subscription
  of its ended long ago.
- On Starter the workspace still picks its own extra tool; the pick is kept
  on the grant.
- The end date runs through the end of that day, UTC.

**Extending a trial** isn't a separate action. A real trial lives on the
Stripe subscription, and this area doesn't change Stripe. Give an internal
plan with an end date instead.

## Not built yet

Seeing a workspace as its owner does, changing a workspace's data, deleting a
workspace, adding or removing admins from a screen, and emailing customers.
