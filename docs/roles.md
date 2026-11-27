# Roles and tools

## In plain words

Everyone on a workspace is an **owner**, an **admin** or a **member**. That
hasn't changed.

- **Owners and admins** open every tool the plan includes, Money included.
  There is nothing to set up for them.
- **Members**, to begin with, open every tool too, Money included. That is
  how every workspace starts, old and new.
- An owner or admin can switch on **"Choose which tools each person can
  open"** on Settings → People. From then on:
  - each member opens only the tools ticked for them on the People page
    (Help desk, Bookings, Social, Stock, Shipping, whichever the plan has);
  - **Money is never a member's**, whatever is ticked. Someone who needs the
    money side is made an admin;
  - members don't see what the business pays or earns in margin in the
    other tools either: what an item or a delivery costs, what an order to a
    supplier comes to, what postage cost and the margin on it. Selling prices
    and quantities stay;
  - **Home and Messages** stay open to everyone. Home shows a card only for
    the tools that person can open; a member with no tools yet is told that
    an owner or admin gives them their tools;
  - Settings screens keep the gates they had (most are for owners and
    admins).
- Switching it on doesn't lock anyone out mid-day: everyone already on the
  team starts with every tool the plan includes (bar Money), and the owner
  then unticks what each person doesn't need. **People invited after that
  start with no tools** until some are ticked, on the invite or later.
- Switching it off gives every member everything again. The ticks are kept,
  so switching it back on picks up where it left off.

## How it is held

The rule is one function with one twin:

- `private.tool_allowed(role, on, tools, tool)` in the database
  (20270209000100), `toolAllowed` in `src/lib/team/tools.ts`.
  `tests/db/member-tools.test.ts` holds them equal over every role, switch,
  list and tool.
- The switch is `tenants.tools_per_person` (off by default), changed only by
  `set_tools_per_person` (owners and admins; switching on writes the plan's
  tools for every member with no list yet). A member's list is
  `member_tools` (one row per member, written only by `set_member_tools`,
  owners and admins, never for an owner, an admin or yourself, never Money,
  audited as `team.member_tools`). No row means "never chosen": while the
  switch is on that member has nothing.
- Invites carry their ticks (`invites.tools`, through `create_team_invite`);
  accepting applies them (`private.accept_invite_row`). An invite made while
  the switch is off carries none, and its person is given the plan's tools
  when the switch goes on.
- `private.can_use_tool(tenant, tool)` asks the rule for the signed-in
  person; `private.tool_tenant_ids(tools[])` is the row-level security form;
  `private.can_see_costs(tenant)` is the costs rule; `private.require_tool`
  is for checked functions.
- The app asks `getEntitlements()` (CLAUDE.md rule 7): `can()` is now the
  plan AND the person's tools (`my_tool_access`), `onPlan()` is the plan
  alone, `seesCosts` is the costs rule. A database from before this has no
  `my_tool_access`: then the app behaves exactly as before.

## What is enforced where

### In the database (tested in `tests/db/member-tools.test.ts`)

Every table below has a RESTRICTIVE select policy (ANDed with its own
policy, so later changes to that policy keep it) and a write trigger,
`private.tool_write_guard`, which refuses a signed-in person without the
tool whichever checked function they called. The worker, the sync and
webhooks (no signed-in person) are untouched. While the switch is off both
let everyone through.

- **Money** (20270209000200): `financial_snapshots`, `book_expenses`,
  `book_invoices`, `money_book_accounts`, `money_budgets`,
  `money_charge_decisions`, `money_line_entries`, `money_debt_imports`, the
  four debt tables, `action_proposals` (all its kinds are Money's), and
  Money's settings (`configs`, `config_versions`, `config_proposals` with
  module `dashboard`: reads and writes, so `propose_config_change` and
  `propose_action` refuse a member). Money's 22 reading functions
  (`money_*`, `dashboard_*`), several of which add up the shop's orders that
  the whole team reads, come back empty for anyone without Money.
- **Help desk, Bookings, Social, Stock, Shipping** (20270209000300): every
  one of their tables (tickets and messages to the manual and help articles;
  services, sessions and bookings to the classroom and Eventbrite; posts,
  assets, projects and marketing emails; items, orders, deliveries,
  suppliers, the ledger, bills by email and Michaels; shipping orders,
  parcels, quotes, labels, plans and packing). Writing any tool's settings
  (`configs` of its module) needs the tool too.
- **Checked reads** that went round the policies (20270209000400):
  Shipping's report, Bookings' seat figures and Eventbrite links, the help
  desk's outbox.
- **Costs** (20270209000400): Shipping's report leaves postage, shipping
  collected and margin out for anyone who doesn't see costs; what checked-in
  deliveries cost (`stock_received_costs`) comes back empty for them.

### Reads across tools, allowed on purpose

A tool that shows another tool's rows to do its own job keeps doing so for
its people:

- Help desk reads Shipping's orders and parcels (the customer's parcels in
  the rail) and Stock's items and incoming orders ("when is this back?").
- Shipping, Social and Bookings read Stock's items (photos, weights,
  supplies).
- Help desk reads Social's accounts (answering as a Page); Shipping, Stock
  and the help desk read Social's assets (the logo).
- The shop's own records (`orders`, `order_lines`, `customers`, `products`)
  stay the whole team's: every tool works from them.
- Money (owners and admins) reads everything already.

### In the app only, so far

- **Costs on tables the whole team may read.** Row-level security can't hide
  a column from some people and not others, so these columns are still
  readable through the API by a member who has the table: `stock_items.
unit_cost` / `own_cost`, `purchase_order_lines.unit_cost`,
  `purchase_orders.shipping_cost` / `tax_rate_pct` / `adjustments`,
  `order_lines.unit_cost`, `shipments.cost`, `shipping_label_quotes` and
  `shipping_order_plans.quote_cents`, `class_supplies.unit_cost_cents`. For
  a member the app leaves them out: `loadStock` and `loadOrderList` don't
  select them, the order page doesn't (and its sheet answers "not found"),
  the items export drops the cost column, the To order cards drop what the
  orders would come to, the Sent page selects no postage, and every margin
  (the list, the order page, the bench) is worked out without what the
  shopper paid. Label prices at buying time stay (see below), and the
  classroom's supply cost is read but only shown on the owners-and-admins
  form.
  The owner decided (2026-11-27) that these cost columns staying readable
  through the API for members who have that tool is accepted and will not
  be closed.
- **Heads-ups in Messages** come from every tool and Messages is everyone's,
  so a member still sees, say, a Shipping heads-up without Shipping. None of
  them carries a Money figure.
- Pages: a tool that isn't the person's answers "not found" from its layout
  (`hideToolUnlessOpen`); the rail leaves it off (`buildNav`, `onPlan`);
  Settings lists only what `can()` allows; the assistant offers no Money
  tools, sales figures or Money settings to a member without Money, and no
  help desk search without the help desk (`toolsFor`).

### Judgement calls

- The price of a label at the moment of buying it (the order page's rates,
  the bench, the list's "Best quote") stays: a packer can't choose a service
  without it. The margin beside each of them is left out.
- Selling prices stay everywhere (the help desk rail's order totals, Stock's
  "Sells for", "% Rev").
- A member's own Stock pages still work out order-by dates and suggested
  quantities; only what they would cost is gone.
