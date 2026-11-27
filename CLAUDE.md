# Maker Business Suite

Multi-tenant SaaS for small maker businesses: financial dashboard, help desk,
bookings, social. Customers never manage developer accounts; all integrations
are OAuth apps owned by us.

## Current phase

Phases 0 to 7 are built. Now: the overhaul toward eight full tools in the
house look. All eight are built; what is left waits on decisions (a label
provider, more social networks, video, SMS). See docs/build-plan.md.

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

- Roles and tools (docs/roles.md): roles stay owner, admin, member. Owners
  and admins have every tool the plan includes. Once a workspace switches
  "Choose which tools each person can open" on (`tenants.tools_per_person`,
  off by default, `set_tools_per_person`), a member has only their ticked
  tools (`member_tools`, `set_member_tools`; invites carry ticks through
  `create_team_invite`), never Money, and no costs or margins; Home and
  Messages are everyone's. The rule is `private.tool_allowed` = `toolAllowed`
  (`src/lib/team/tools.ts`, held equal by `tests/db/member-tools.test.ts`).
  In the app, `getEntitlements().can()` already answers for the person
  (`onPlan()` is the plan alone, `seesCosts` the costs rule): never add a
  second gate. In the database every tool table has a RESTRICTIVE select
  policy and a `tool_write_guard` trigger (a new table of a tool gets both,
  with the tools that read it across listed); a checked function that READS
  a tool's rows asks `private.tool_tenant_ids` / `private.require_tool`, not
  just `user_tenant_ids`; a new Money reading function returns nothing
  unless `private.tool_open(tenant, 'dashboard')`. A loader that reads a
  cost (what the business pays, or a margin) leaves it out unless
  `seesCosts`. Keep `tests/db/member-tools.test.ts` passing.
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
  Members can read a connection's `scopes` and `metadata` (nothing secret
  lives there; tokens are in Vault) but not the whole row, so always name
  the columns: a `select` that names a column members can't read fails as a
  whole and the page quietly behaves as if nothing were connected.
  A Shopify connection's `scopes` is what the store reports
  (`currentAppInstallation.accessScopes`, `shopify-scopes.ts`), written by
  `record_granted_scopes` on connect, after each shop read and on "Check
  again"; never what we asked for (managed installation ignores the `scope`
  we send). Watch-only keeps only `read_*`. Screens that need a shop
  permission use `shopPermission()` and `<ShopPermissionNote>`
  (docs/shopify-permissions.md).
- Money view: dashboards are JSON in `configs` (module `dashboard`), parsed
  with the Zod schemas in `lib/dashboard/schema.ts` on every read. Sync writes
  go through service-role functions that name the workspace
  (`upsert_commerce_batch`, ...); dashboard queries run as the member under
  RLS. Chart text is formatted on the server (`prepareTimeChart`) so server
  and browser output match. Charts follow one validated series colour
  (`--chart-1`) and always offer a table view; several business lines are
  small multiples on one scale (`LineMultiples`), never a second colour. ONE
  owner-approved exception: the payoff projection (Money → Payoff plan) is
  one line chart with a colour per debt (`payoff-chart.ts`,
  `MultiLineChart`), from the categorical palette `--chart-cat-1`…`8` /
  `--chart-neutral` (`lib/charts/palette.ts`, light and dark, held to
  globals.css and checked for contrast and colour-blind separation by
  `palette.test.ts`), each slot with its own dash and marker, a legend that
  toggles lines, end labels where they fit, the table view, and past eight
  debts the rest as one "Other debts" line. Use that palette nowhere else
  without the owner's say.
  Revenue settings are a config (`dashboard` / `revenue`,
  `lib/dashboard/lines.ts`, Settings → Money → Revenue and business lines):
  the figure (`net_sales`, the default, served by the earlier queries so
  nothing changes, or `order_totals`, refunds always out:
  `orderRevenueCents` = `private.money_order_cents`), `by_class_date` (off by
  default) and the workspace's own lines and rules (order tag, product tag,
  product type, Bookings workshop; first match wins, else `default_line`;
  never a line or tag word in code). `lineFor` is the one evaluator, run on
  rows `money_line_revenue` adds up per set of facts (paged), which shares an
  order among its items to the cent (`splitCents`) and finds a class's date
  from Bookings, then from the cart line. The sync keeps `orders.tags`,
  `products.tags` and `order_lines.session_ref` / `class_date`; a sender that
  leaves them out keeps what is stored, a forgotten shopper keeps only the
  tags a line rule names, and `queue_commerce_detail_reads` reads each older
  shop's history once (done only when the new code's full read says so).
  Keep `tests/db/money-lines.test.ts` and `money-order-details.test.ts`
  passing.
  Expenses (Money → Expenses to sort; docs/money-side-by-side.md): for a
  workspace with Money, the QuickBooks sync (read-only, the accounting
  scope already granted) reads purchases, bills, journal entries' debit
  side, transfers and card payments since the first of January last year
  (`quickbooks-expenses.ts`) into `book_expenses` through
  `file_book_expenses` (keyed by the books' kind and id; facts follow the
  books, the sorting never does) and `close_book_expenses` (what a complete
  read no longer saw is marked removed). Transfers and card payments are
  `is_move`: never sorted, listed or counted. Sorting is a line, a split
  (whole percents, `splitByPercent`: leftover cents to the largest share),
  shared or set aside; a person's choice (`sort_book_expenses`, owners and
  admins) always wins, and "Put back in the inbox" sets `rules_off`. The
  ACCOUNT is the unit of sorting: one choice per books account (a line,
  split, shared, set aside or "decide each one"; `accounts` in the
  `dashboard` / `expenses` config, keyed by the books' account id, else the
  exact name) sorts every expense in it, applied in the database
  (`private.money_follow_accounts`, `apply_expense_accounts`,
  `sorted_by = 'account'`, re-decided on every sync). An account with no
  choice counts as shared and never fills the inbox. Payee defaults and
  rules (payee, account, memo, class, location) make exceptions
  (`decideExpense`: firm rules, payee default, other rules, then the
  account; its last step is the database's twin, held by
  `tests/db/money-expense-accounts.test.ts`), applied in code as expenses
  arrive and on "Apply my rules to what's waiting"
  (`note_expense_decisions`), never over a person's choice; never a payee,
  bank or account name in code. Money calls a model in two places only,
  each a person's press with structured output and no tools: "Suggest
  lines for these" (`expense-suggest.ts`, `E1`/`L1` references,
  `tidySuggestions`; it only writes a suggestion, applied by a person's
  "Use this") and the debt what-if (below). Profit by line
  (`lib/dashboard/profit.ts`, config `dashboard` / `profit`, Settings →
  Money → Profit by line) is revenue − cost of goods (only when counted from
  the shop's item costs) − its expenses − its share of shared ones − its
  share of monthly costs (prorated by the day); unsorted, set aside and
  unsplit amounts are shown apart. Keep `tests/db/money-expenses.test.ts`
  passing.
  Cash health (`lib/dashboard/health.ts`, pure, whole cents; config
  `dashboard` / `health`, Settings → Money → Cash health, defaults the
  earlier dashboard's thresholds): the QuickBooks sync also reads the
  CashFlow report (cash basis) by month into `cash_flow` snapshots, other
  income / other expenses into each P&L month (`*_cents`), and both from
  three Januaries back (`reportsSince`); cash flow trouble never stops the
  sync. Only complete months (in the workspace's timezone) count; operating
  profit leaves other income and expenses out; burn is minus the average
  operating cash flow, else expenses less revenue; runway has no limit
  while cash grows; growth needs two full windows. A P&L month stored
  before other income was read is "not known", never 0. The money view
  reads the monthly kinds and only the latest balance sheet / aged
  receivables (`latestOf`), so a long history never crowds them out. Ranges
  include this / last month, this / last quarter, year to date and last
  year; a range picks the books' months with `rangeMonths`.
  Budget (Money → Budget, `lib/dashboard/budget.ts` + `budget-data.ts`;
  config `dashboard` / `budget`): `money_budgets` per account or line per
  month, written only by `set_money_budgets` / `copy_money_budget_month` /
  `fill_money_budget_year` (owners and admins); actuals from
  `money_account_totals` (moves and set-aside never count) or the sorted
  expenses shared out as profit by line does; variance, averages, expected
  cost of goods and break-even worked out on read. Which accounts rise with
  sales, which are hidden and the cost of goods share are the config (blank
  share = the books' own); never an account name in code. Cost cutter
  (Money → Cost cutter, `lib/dashboard/recurring.ts`; config `dashboard` /
  `cost_cutter`): a payee (spellings folded by `foldPayee`) charging in
  `min_months` different months is recurring; decisions are
  `money_charge_decisions` through `decide_money_charge`, a note for the
  team that cancels nothing. No model call in either. Keep
  `tests/db/money-budget.test.ts` and `money-cash-flow.test.ts` passing.
  Debt payoff and the emergency fund (Money → Payoff plan / Debts / What
  if…, Settings → Money → Debt payoff) are for OWNERS AND ADMINS ONLY, held
  in the database: `money_debts`, `money_debt_balances`,
  `money_debt_plan_months` and `money_debt_scenarios` are readable only by
  them and written only through checked functions; moves in
  `book_expenses` (payments into a card or loan) and the `dashboard` /
  `debt` config, its versions and proposals are hidden from everyone else
  (`private.config_owners_only`, which must list the same settings as the
  registry's `ownersOnly`). Everything else reads debts as the member, so
  for anyone else there are none: the menu rows, pages (404), the two cash
  health tiles and notes, the budget's debt rows, the home card's debt line
  and the assistant's view of the setting are simply absent; keep it that
  way for anything new. A debt's kind is a field (`plan`: pool, fixed,
  revenue_share; `revolving_bp`), never a name match; never a lender or
  bank name in code. The debts COME FROM THE BOOKS: each QuickBooks sync
  hands every liability line of the balance sheet it already reads (with
  the books' account id and section) plus the chart of accounts' liability
  types (one read-only `Account` query, same scope) to
  `file_debts_from_books` (service role, through `fileBookDebts`), which
  keeps them in `money_book_accounts` and makes, joins (a typed-in debt
  linked to an account of that name) or updates the debts
  (`private.book_debt_apply`), keyed by the books' id, else the exact name.
  Which liabilities are debts by themselves is `lib/dashboard/debt/books.ts`
  (`countsAsDebt`: the books' type or detail type, else the sheet's
  section, against the debt setting's `books_debt_types`); never a name.
  A person's "Count this as a debt" / "Not a debt" (`choose_book_liability`,
  `money_debts.left_out_at`) sticks across syncs. A sync writes only the
  books' facts (name, account, balance, closed when a COMPLETE read no
  longer has the account, open again when it's back) and NEVER what a
  person fills in (rate, minimum, payment, due day, plan, priority, note);
  a rate not given is null ("Needs a rate"; the plan counts it at 0% and
  says so). A books debt's balance can't be typed and it is never removed.
  Balances are dated entries, one per day per source; the current one is
  the latest, and for a books debt only the books' (`money_debt_current`).
  A debt not in the books can still be typed in. Earlier workers'
  `note_debt_balances_from_books` still works. Payments are moves into the
  debt's account (`money_debt_payments`), by the books' account id
  (`book_expenses.account_ref`) where both sides have one, else by name. The
  engine (`lib/dashboard/debt/engine.ts`, ported from the earlier
  dashboard with its quirks, tests in `engine.test.ts`) is pure on whole
  cents: interest = balance × rate bp ÷ 120,000 and every share rounded to
  the nearest cent, half up, in exact integers (`shareOf`); change a rule
  only with its test. The plan marks one order "Recommended"
  (`debt/recommend.ts`, pure: clears the debts, then least interest, then
  sooner, then avalanche, snowball, hybrid, custom) and follows it while
  the setting's `strategy_from` is `recommended`; "Use this order" sets
  `person` and sticks. A debt's place in "your own order" (`priority`) is always
  1..N among the debts that take one (pool, active, not a plan, not folded
  into an open plan: `debt/order.ts`, twin of `private.money_debt_renumber`);
  a trigger renumbers after any change to which debts take a place (new ones
  go last), and a move (`move_money_debt`, or a place given on save or
  import) is an insert. A move by hand also switches the plan to `person` /
  `custom`. Keep `tests/db/money-debt-order.test.ts` passing. The fund's accounts are `emergency_picks` (books'
  id, else name; earlier `emergency_accounts` names still read), ticked
  from the latest balance sheet. "Also in your books" can be hidden
  (`hide_book_liability`, `money_book_accounts.hidden_at`: the list only).
  Debt details come across from a CSV (`debt/import.ts`,
  `import_money_debt_details` under a request key, filling only what nobody
  set; docs/money-import.md). The what-if (`what-if.ts`): Claude only picks which
  figures a question changes (`D1` references, `tidyWhatIf`), the engine
  answers, the reply is the engine's figures, nothing is kept unless a
  person presses "Keep this what-if", and it counts against the AI
  allowance. A debt paid through a plan (a consolidated debt:
  `money_debts.consolidated`, one `fixed` payment, written only by
  `save_money_debt_plan` / `cover_money_debt` / `import_money_debt_plans`)
  covers debts that point at it (`covered_by`, one plan each); its balance
  is the covered debts added up on read, its books account's, or typed in.
  `foldDebts` / `foldPayments` (`debt/plans.ts`, pure) fold covered debts
  in inside `loadDebtBook`, so NOTHING counts a covered debt on its own
  (totals, plan, tiles, budget, home card, what-if, recommended order); never
  sum or change a covered debt elsewhere, and a sync never writes any of it.
  The projection is small multiples (`debt/projection.ts`). Keep
  `tests/db/money-debts.test.ts` passing.
  Finish setting up (docs/setup-pattern.md): `moneySetupItems`
  (`lib/dashboard/setup.ts`, pure) works the open items out from what
  `loadMoneySetupFacts` reads (debts only for owners and admins; `deep`
  only on Money → Set up), shown as a folded card on Money and as the steps
  of `dashboard/setup`, whose forms write through the existing actions and
  checked functions. Only "Not now" is stored (`setup_not_now`, owners and
  admins, a fingerprint of ids and counts). "How this is worked out" words
  are `lib/dashboard/explain.ts` (pure, no model). The assistant reads
  `money_setup_status` / `list_expense_accounts`, and owners and admins also
  `list_debts` (references `D1`/`L1`, never ids) and the three debt
  proposal tools: `action_proposals` rows applied by a person through
  `claim_action_proposal` then the checked function (`applyAction`).
  More action kinds, for the whole team to file and owners and admins to
  apply: `money.expense_sort` (`sort_book_expenses`), `money.budget`
  (`set_money_budgets`), `money.charge` (`decide_money_charge`), with
  expenses and charges as `E1`/`C1` references; applying one writes its
  before/after words onto the row (`note_action_applied`, only by who
  applied it) and the assistant page lists them. Debt kinds stay
  owners-only, history included.
  Revenue from the books (revenue config `books`, off by default): paid
  invoices (`book_invoices`, read-only with every sync, `file_book_invoices`
  / `close_book_invoices`, each line's income account from the item list
  and its share before tax, `splitCents`) count by the income account's
  choice (a line, `{skip: shop}` for the shop's own sales so nothing counts
  twice, `{skip: other}`; no choice counts nowhere and is shown apart), and
  the P&L's other income goes to a line or beside them (`bookRevenue`,
  `booksRevenueExplained`). Invoice status is worked out on read
  (`invoiceStatus` = `private.invoice_status`). Money → Invoices, Orders
  (`money_order_list`), Statements (each P&L month and the balance sheet
  keep every account's line, `statementLines`) and Projection (config
  `dashboard` / `projection`, `lib/dashboard/projection.ts`). A page's range
  is a preset or any month, quarter or year (`pageRange`, `RangePicker`).
  Month-by-month entries (`money_line_entries`, `set_money_line_entries`):
  a monthly cost's own figure for one month, and revenue typed in for a
  line. Spreadsheets (`lib/dashboard/export.ts`, routes beside each page)
  are built from the page's own loader as the member; debts only for owners
  and admins. Shipping margin by month is `money_shipping_by_month`;
  break-even pace and the same days last month are `lib/dashboard/pace.ts`. Keep
  `tests/db/money-invoices.test.ts`, `money-line-entries.test.ts`,
  `money-order-list.test.ts`, `money-shipping-margin.test.ts` and
  `action-proposals-money.test.ts` passing.
- Help desk: inbound email is authenticated by a secret in the webhook URL,
  queued (`private.inbound_emails`) and filed by the worker through
  `file_inbound_email` (the older `ingest_inbound_email` hands over to it),
  which threads by the ticket's reply key, then by mail headers, and keeps
  who else the email went to (so "Reply all" fills in, never with our own
  addresses: `replyAllCopies`, the `own_addresses` setting). The whole
  plain-text part is kept (`chooseBody` in `lib/helpdesk/inbound.ts`; never
  the mail service's guess at "just the reply") and the quoted part is folded
  on screen (`splitQuote`), so a note above a signature is never lost. `tickets.reply_key` is never readable by clients. Customer
  email is shown as plain text only. Reply templates and auto-tag rules are
  `configs` (module `helpdesk`). Claude drafts go into the reply box and are
  never sent automatically; customer text in the prompt is marked as data.
  The inbox is one full-window page (`w/[slug]/helpdesk/page.tsx`) of three
  panes, each scrolling on its own: the list, the conversation with its
  composer, and a details rail (Details / Activity). Its whole state is in the
  URL (`view`, `tag`, `q`, `t`, the filters `assignee` / `priority` / `unread`
  / `sort`, and `side` for the rail); only "rail folded" is a cookie. `view`
  is a built-in view, a folder (`f:<id>`) or a saved view (`v:<id>`):
  `parseView()` and `inView()` in `lib/helpdesk/views.ts`, so a snooze needs
  no timer. Folders are `ticket_folders` (managers make them, anyone files
  with `file_ticket`); a filed conversation leaves the inbox views. Saved
  views are a config (`helpdesk` / `saved_views`, `lib/helpdesk/saved-views.ts`).
  The menu panel's folders, views, tags and counts are what the inbox has
  already read (`<PanelExtras>`); it never runs a query for them. Unread is
  each person's own (`ticket_reads`), worked out on read with the list's other
  facts (`ticket_list_facts`, never stored). `ticket_events` is the activity
  log, written only by a trigger on `tickets` (and a forward); it never holds
  a subject's words. Mail goes out through one path (`sendMail` → `deliver`
  → `record_outbound`): reply, copies, forward, files, and what happens
  next (in progress, open, snoozed, closed). With an undo wait set
  (`helpdesk` / `desk_settings`) `deliver` queues the email instead
  (`queue_outbound`, `private.outbound_queue`) and the worker sends it when
  due (`drainOutbound` → `finish_outbound`, which files it acting as its
  author); "Undo" is `cancel_outbound` on the server, never a browser timer.
  A refusal is kept as failed with its words; a send never finished is
  "unsure" and never resent. A saved reply can also act when sent
  (`templateActionsSchema`: tags, then, hand-off; `apply_send_actions`).
  Pictures and files, in and out (`lib/helpdesk/files.ts`,
  `keep-files.ts`): kept only when their own first bytes say they are one of
  the kinds on the list (never by name or claimed type; no html, svg, office
  files or programs), under caps (25 MB a file, 35 MB an email, 500 MB a
  workspace a day), in the PRIVATE `helpdesk` bucket at
  `<workspace>/<ticket>/<message>/<random>`; `message_attachments` lists
  every file, kept or not, and is written only by the server
  (`record_message_attachments`). They are served only by
  `/api/helpdesk/files/[id]`, which reads the row as the member and sets
  the headers itself (`fileHeaders`); a picture set into an email is our own
  `<img>` placed by `placeInline`, never the email's markup. Deleting an
  attachment row, however it happens, queues the file for removal
  (`private.attachment_removals`, emptied by the worker). Prompts are told a
  message had files by name and kind only.
  Archive, Spam and Trash are `tickets.shelf` (`shelve_ticket`): a shelved
  conversation is closed and in no working view (`inView`); archived comes
  back when the customer writes, spam and trash stay put, and anything that
  reopens a conversation takes it off its shelf (a trigger). Deleting for
  good is manager-only and only from the Trash; nothing empties it by
  itself. Ticked rows change together through one checked function
  (`bulk_update_tickets`); the list exports as a spreadsheet without message
  text (`lib/helpdesk/export.ts`, managers). Tag changes are logged by a
  trigger on `ticket_tags`. Tag groups are a config (`tag_groups`). Formatting is a
  small document (`lib/helpdesk/rich.ts`): the editor hands it over, the
  server checks it and writes the HTML and plain-text parts itself, and the
  thread draws it as React nodes; no HTML from a browser or a customer is
  ever sent or rendered. Unsent drafts live in the browser only. The customer
  and orders in the rail come from what the shop sync stored, read as the
  member (`helpdesk/data.ts`, `lib/helpdesk/customer.ts`): no call to the
  shop, and Shipping's and Stock's parts are allowed to fail. "Summarize"
  (`lib/helpdesk/insights.ts`) is a person's press, kept on the ticket, never
  sent. Notes
  for the team live in `ticket_notes` and are never emailed. A conversation
  joined into another keeps a `merged_into` pointer, and later mail follows
  it. Rules (`auto_tag_rules`) can tag, set priority or hand off; the worker
  applies the last two through `apply_ticket_rules` after filing.
  The manual (`lib/helpdesk/manual`, pages under `(app)/helpdesk/manual`,
  set up under Settings → Help desk → Manual): topics written up from
  finished conversations, and hand-written articles. NOTHING in it is about
  one trade: its name, the labels topics are sorted by, the headings they
  are written under and which folders, saved views or tags feed it are a
  config (`helpdesk` / `manual`); never add a word list or a code path for
  one business. A topic's body is the small document of `rich.ts`; an
  all-bold one-line paragraph is a heading (`sections.ts`). The worker
  claims a run (`claim_manual_runs`: by itself only where `auto` is on, or a
  manager's `request_manual_run`), and for each closed, answered source
  conversation not yet in `manual_reads` asks Claude with structured output
  and no tools (`reader.ts`): the words scrubbed (`scrub.ts`), up to three
  of the customer's kept photos, never a video, and a shortlist of existing
  topics under references of ours (`T1`…), so the model never sees or names
  an id. Its answer is only data for `tidyReading` (scrubbed again) and
  `planReading`, which decides in code: a new draft, points added under
  their headings (`mergeAdditions` never changes what is written), or, for
  a topic a person has edited (`person_edited_at`), a row in
  `manual_suggestions` for a person to accept or dismiss.
  `apply_manual_reading` is the ONLY writer of a reading and re-checks that
  rule under the row's lock. Nothing is published by itself; every change
  leaves a `manual_topic_revisions` row. Runs stop at the plan's AI
  allowance and the workspace's `monthly_cap`. Published topics are offered
  in the reply box's picker (`findInManual`), beside a conversation and to
  the "AI" draft as marked reference (`match.ts`: word matching, no model
  call on a page load). Keep `tests/db/helpdesk-manual.test.ts` and
  `manual/run.test.ts` passing.
  A topic can show the customer's photos and videos (`manual_topic_media`:
  ids pointing at `message_attachments`, nothing copied, served only by the
  private file route): a reading only offers a conversation's kept pictures
  and videos as candidates through `apply_manual_reading`; a person keeps,
  captions and orders them. Claude's picks (`tidyExtras`, pictures it was
  shown under our references `P1`…, never a video) are a mark on a
  candidate. The row goes when the attachment's row goes (a cascade; keep
  `tests/db/helpdesk-topic-media.test.ts` passing). `manual_topic_cases` is
  one scrubbed line per source conversation. Joining two topics is done by
  rule (`manual/join.ts`, manager-only `merge_manual_topics`), never by a
  model.
  The help centre (`app/help-centre/[workspace]`, docs in the side by side):
  public pages for help articles a manager published. An article's
  `public_state` is internal, draft or published; a published one is changed
  only by owners and admins. The pages have no database access of their own:
  they read through `lib/helpdesk/help-centre-server.ts`, which names the
  workspace, asks `moduleOpen()` and calls the service-role functions
  `help_centre_list` / `help_centre_article`; those return ONLY published
  articles of a workspace whose `helpdesk` / `help_centre` config is on
  (keep `tests/db/helpdesk-help-centre.test.ts` passing; a topic is never
  public). `src/proxy.ts` asks `helpCentreGate()` before a page is drawn, so
  a missing page is a real 404 and an old address (`help_article_slugs`) a
  real redirect; these paths never read a session. Reads are cached under
  `helpCentreTag(slug)`: every action that changes what a visitor sees calls
  `updateTag`. Words are drawn as React text (`publicDoc`: https links
  only); an article's own pictures live in the PUBLIC `help-centre` bucket
  (`<workspace>/<article>/<id>`, checked by their first bytes in
  `finishArticlePicture`) and never come from the private `helpdesk` bucket.
  Search and “Was this helpful?” are rate-limited in the database
  (`help_centre_allow`, a salted fingerprint, no address stored, no cookie).
  “Make a help article from this topic” and Claude's draft
  (`help-centre/draft.ts`) only ever make a DRAFT copy. Publishing to a
  shop's blog is not built: it needs a shop write permission.
  Instagram and Facebook messages (`lib/helpdesk/social`,
  docs/meta-messages.md) are a channel beside email (`tickets.channel`), on
  the Social tool's `meta` connection with OPTIONAL messaging permissions
  asked only from Settings → Help desk → Channels; the granted `scopes`, the
  `helpdesk` / `channels` config and `channelState()` gate everything.
  `/api/webhooks/meta` checks `X-Hub-Signature-256` on the raw body and only
  queues (`private.meta_events`; `enqueue_meta_event` drops what no workspace
  has connected); the worker routes each entry by its platform id to the
  workspace AND the account (`resolve_meta_account`, through
  `social_accounts`) and files through `file_account_message` /
  `file_account_comment` (they hand over to `file_social_message` /
  `file_social_comment`: one conversation per person per account, since
  Meta's person ids are per Page and per Instagram account; once per Meta
  message id), echoes, unsends and reactions through their own functions.
  Every conversation carries `tickets.social_account_id` and is answered as
  that account through its own Page (`social_ticket_account`,
  `getMetaPageToken`): replies, private replies, hide and delete, thread
  control and the automatic reply alike; the inbox names it and filters by
  it (`account`). An account's Page `tasks` gate it too (`accountAllows`). A person has no email:
  `contacts` carries `external_id` and `handle`, and the shop is matched only
  by a `known_email` the team wrote down, never by name. Files are fetched
  from Meta's hosts only (`metaFileUrl`), never a profile picture. Replies
  are plain words through the same outbox (`sendSocialMessage` →
  `sendSocialReply` → `record_social_outbound` / `finish_social_outbound`);
  Meta's 24-hour window is worked out on read (`replyWindow`) and re-checked
  on the server, and the HUMAN_AGENT tag is used only where the config says
  the app is approved (off by default).
  Meta lets one tool at a time answer a conversation ("thread control";
  docs/meta-messages.md, "Using this alongside another inbox tool"). A send
  refused for it (`ownedElsewhere`) is explained in our words with Meta's
  under "Details", stays failed and is never resent by itself; only with the
  workspace's `take_control` setting (off by default) does `sendSocialReply`
  take or ask for the conversation and try once more. Messages on Meta's
  `standby` list are filed like any other; who has a conversation is a note
  on the person (`contacts.thread_control`, written only by
  `note_thread_control`), a heads-up that never blocks a reply. Never take
  control without that setting.
  The automatic first reply (`lib/helpdesk/auto-reply`, Settings → Help desk
  → Automatic replies, config `helpdesk` / `auto_replies`,
  docs/meta-messages.md) is the ONE thing the help desk sends by itself, and
  it is FIXED WORDS ONLY: what an owner or admin typed, with `{{first_name}}`
  and `{{business_name}}` filled in by code (`fillWords`). NO MODEL MAY BE
  CALLED ON THAT PATH, and nothing a model wrote may be sent by it:
  `auto-reply/guard.test.ts` fails if that folder or the outbox and
  deliverers behind it import an AI helper, and the assistant's registry
  entry refuses any proposal that changes a message (`refuse`). The worker
  decides when a message is filed (`shouldAutoReply`, pure: real messages
  only, never a comment, reaction, echo, machine mail, Spam or Trash; opening
  hours on the workspace's clocks; a quiet period per person and channel;
  never once the team has answered), `claim_auto_reply` takes one claim per
  inbound message (`private.auto_replies`) and queues it in the same outbox
  with no author and no undo wait, and `finish_outbound` /
  `finish_social_outbound` file it as `messages.automatic`. It never counts
  as the team answering (status, `first_reply_at`, assignee, the list's last
  message and the manual all ignore it), and a refusal is written down once
  and never retried. Keep `tests/db/helpdesk-auto-replies.test.ts` passing.
  Comments on posts ride on the same connection, webhook and queue
  (`comments.ts`, `tickets.kind = 'comment'`, `comment_posts`): one
  conversation per person per post (`file_social_comment`), never mixed or
  joined with that person's message conversation, which shares only the
  contact. Their own switches (`instagram_comments`, `facebook_comments`) and
  permissions gate them (`commentState()`, `private.meta_comment_channel`).
  Which comments start a conversation is a setting (`comment_filter`,
  `comment_words`) read by `startsConversation()`; never add a word list for
  one business. A post is asked about once, for its address and caption only
  (`readPost`, `postLink`: the platform's own hosts), never its media.
  Replies go through the one outbox with `via` on the payload
  (`sendCommentReply`): "public" is a comment under the comment, "private"
  is Meta's one message per comment, which `claim_private_reply` holds (a
  refusal releases the claim; no clear answer keeps it). The reply box and
  its buttons always say when a reply is public. Hide and delete ask Meta
  first, then `mark_comment_hidden` (the team) / `mark_comment_deleted`
  (owners and admins).
  A login to Facebook asks only for the uses a workspace is switching on
  plus what its connection had (`lib/connections/meta-access.ts`: posting,
  messages, each platform's comments), and records what was granted;
  Social posts only where `canPost()` says so. Keep
  `tests/db/helpdesk-comments.test.ts` passing. What the
  old help desk does that this one doesn't is in
  `docs/helpdesk-side-by-side.md`.
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
  database; the worker only adds the words. A tool's several places are
  rows in its menu panel (`lib/nav/model.ts`), not tabs.
  Classes that run at the same time can share one room's places
  (`session_seat_groups`, `sessions.seat_group_id`; manager-only
  `share_session_seats` / `set_shared_limit` / `unshare_session_seats`, from
  the date's page): a booking needs room under the date's own limit AND the
  shared one (`private.has_room`), seats left are `private.seats_left`
  everywhere (public pages, the picker, `session_seat_figures` for the
  team's pages via `lib/bookings/seats.ts`). Anything that gives out seats
  locks through `private.lock_seats` first: shared limits by id, then dates
  by id, re-reading if a date moved between limits; never lock a date and
  then reach for a limit. Keep `tests/db/booking-shared-limits.test.ts`
  passing. A date's day or time is changed with `move_session` (people keep
  their place; a reminder already sent is not sent again for the new time,
  as in the business's earlier app; the person ticks whether everyone is
  emailed), a date nobody ever booked is removed with `delete_session`, and
  `raise_limit_to_fit` lifts an oversold date's limit (and its shared
  room's) and clears the marks. A workshop's place (`services.location`,
  `set_service_location`) shows in the picker, on our pages and in emails.
  All manager-only; keep `tests/db/booking-date-changes.test.ts` passing.
  Bookings imports (Settings → Bookings → "Bring your bookings across",
  docs/bookings-import.md) copy Stock's design: `lib/bookings/import`
  (pure, tested) reads workshops, dates and bookings files; the three
  `import_booking_*` / `import_bookings` functions run for a look or for real
  under a request key (`booking_imports`), and the same file again changes
  nothing. A date keeps the earlier app's id when it is free (an id in use
  anywhere else is refused in words that give nothing away); imported
  bookings send nothing, carry what was already sent as `booking_emails`
  and `booking_texts` rows (no thank-you for a class already over; a text
  whose email went counts as gone), keep their shop order so
  `book_from_shop` finds them and their `eventbrite_order_id` so
  `book_from_eventbrite` does (matched by earlier id, then Eventbrite order,
  then shop order and date), and keep `customer_phone` / `text_opt_in`
  (texts follow them only once texts are switched on). Keep `tests/db/booking-imports.test.ts` passing.
  A workshop can instead be sold through the business's own shop
  (`services.shop_product_id`): the date picker on the product page
  (`public/booking-widget.js`, plain JS in a shadow root, reads
  `/api/book/shop`) puts the date on the cart line as "Session ID", the
  shop takes the payment, and the order sync turns it into a booking with
  `book_from_shop` (once per order line, wherever the booking was moved:
  it is known by the shop's line ids and the cart's date,
  `shop_line_ids` / `shop_cart_session_id`, matched by
  `private.shop_booking_for` from the stored `order_lines`; the seats follow
  refunds; a full or closed date is still booked and flagged; a new line
  for the date a moved booking sits on is `clash`, for a person). An order
  from the shop's history (class started, or placed before the workshop's
  `shop_linked_at` or before its date existed here) is written down
  `history_only` and answered `recorded`: nothing is ever sent to it by
  itself, until the bookings import takes it over. Keep
  `tests/db/booking-shop-moves.test.ts` and `booking-shop-history.test.ts`
  passing. Such a workshop can't be booked or paid for on our own pages.
  The emails that go out by themselves (reminder, day-of reminder,
  thank-you, "a refund in your shop cancelled your booking") follow the
  once-only pattern (`lib/bookings/email-sends.ts`, `booking_emails`):
  `claim_booking_email_sends` hands each out once, the worker tries it once
  and `finish_booking_email_send` writes down how it went. A refusal is tried
  again (three tries in all, counted in the database), a send we never heard
  back about is "unsure" and never resent by itself, and
  `bookings.reminder_sent_at` / `followup_sent_at` are stamped only once the
  email went: never stamp before sending. `deliverEmail()` in `lib/email.ts`
  tells those outcomes apart; the older `claim_booking_emails` and
  `claim_booking_reminders` stay but hand nothing out. The day-of reminder
  is off unless `day_of_on` is set. "Pause messages to customers" (`paused`
  in bookings / emails, owners and admins) stops every email and text that
  goes by itself, read by both claims in the database; `announceBooking`
  holds confirmations. Nothing missed is sent late: a reminder only while
  its class is ahead and inside its lead time, a thank-you not if it fell
  due while paused (`private.booking_messages_paused_at` reads
  `config_versions`), and what was set off while paused is written down as
  held (`PAUSED_WORDS`; keep `tests/db/booking-pause.test.ts` passing).
  "Send the confirmation again" gives the
  booking a new link (`renew_booking_link`: only the hash is kept), so the
  earlier one stops working. Keep `tests/db/booking-emails.test.ts` passing.
  A shop order for a workshop with no usable date on its line ("Buy again"
  strips it) is never dropped: the sync hands every order line to
  `note_shop_undated_lines` (`lib/bookings/undated.ts`), which writes a
  marker in `shop_undated_lines` once per order line, and the team is told
  once (only for orders placed since the workshop was linked to its product,
  `services.shop_linked_at`, so a first sync of a shop's history doesn't
  flood the list). Markers hold no shopper: who bought is read from what the sync
  stored (`orders`, `order_lines`, `customers`), by the shop's own ids
  because the sync rewrites `order_lines` rows. A manager puts a line on a
  date with `place_shop_order_line` (from Bookings → Needs a date, or from a
  roster by the order's number with `find_shop_order_for_session`; no call
  to the shop): under the date's row lock, one booking per line, a full date
  booked and flagged oversold, never refused. From then on the sync keeps
  that booking in step with the order (fewer places, cancelled on a refund).
  Keep `tests/db/booking-undated.test.ts` passing.
  Every booking email's subject and words are the business's own (config
  `bookings` / `email_words`, `lib/bookings/words.ts`, Settings → Bookings →
  Email words): plain text with fill-ins filled by code (`bookingEmail`,
  `fillTemplate`), never markup and never a model; a message not changed uses
  `DEFAULT_WORDS`, which `words.test.ts` holds line for line against the
  older `emails.ts`. The reply-to rides on every customer email; the
  assistant may propose it but never the words (`messageWordsChanged`).
  "Send me a test" goes only to the signed-in person. Bookings → Emails sent
  reads `booking_emails`. The runsheet and a date's roster PDF are words
  first (`runsheet.ts`, pure) then drawn (`runsheet-pdf.tsx`, server only);
  "Returning" is worked out on read by email (`loadReturning`), never
  stored. All bookings keeps its filters in the address (`all-bookings.ts`).
  The home card's Bookings line is `home-summary.ts` (good news only,
  allowed to fail). "Upcoming classes" for a shop's workshops page
  (`public/upcoming-classes.js`, config `bookings` / `upcoming`, off by
  default) reads `/api/book/upcoming` through `shop_upcoming_classes`:
  public, open, future dates with a place left, links only to the product
  pages the shop sync stored (`safeProductUrl`). The owner's daily email
  (`daily-email.ts`, config `bookings` / `daily_email`, off by default, to
  members an owner or admin chose) is once per person per local day
  (`booking_daily_emails`, `claim_booking_daily_emails` /
  `finish_booking_daily_email`); keep `tests/db/booking-daily-email.test.ts`
  and `booking-upcoming.test.ts` passing.
  What a business can vary about the product-page picker is a config
  (`bookings` / `shop_page`, `lib/bookings/shop-page.ts`), set under Settings
  → Bookings → Shop product page, where the two theme snippets are built
  (`pageSnippet`, `cartGuardSnippet`: pure, tested). The page snippet draws
  only for products with the workspace's workshop tag and hides the theme's
  buy button with a style rule from the first paint; the picker never brings
  it back. If dates can't be shown (script blocked, our server down, no such
  workshop) the shopper sees the snippet's own message and contact link:
  never a buy button with no date. A host without `.mbs-fallback` is a
  snippet pasted before this and is left as the theme drew it. Times carry a
  plain label worked out on the server per date (`zoneLabel` in `slots.ts`:
  "ET", "PT", "BST"); keep its daylight-saving tests passing.
  Text reminders (docs/text-reminders.md; `lib/texts`, Settings → Bookings
  → Text reminders, config `bookings` / `texts`, all off by default, gated
  by the `texts` entitlement) go through the business's own Twilio account:
  provider `twilio`, a pasted Account SID, auth token and sender, the token
  read only through `getTwilioAccess()`, and ALL Twilio HTTP through
  `lib/texts/twilio-client.ts` (plain fetch, no SDK). Texts follow the
  emails' once-only pattern in their own table (`booking_texts`,
  `claim_booking_text_sends` / `finish_booking_text_send`, unique per
  booking, message and date; never stamped before sending), only to a
  booking with `text_opt_in` and a number `toE164` can read without
  guessing a country beyond `default_country`. FIXED WORDS ONLY: no model on
  the path (`lib/texts/guard.test.ts`), and the assistant may not propose
  the words (`textWordsChanged`). `/api/webhooks/twilio` checks
  `X-Twilio-Signature` with the workspace's own token (401 otherwise), keeps
  only STOPs (`private.twilio_inbound`, once per message id) and the worker
  takes the number off (`apply_text_opt_out`, `booking_text_opt_outs`);
  START opts nobody back in. Consent rides on the cart line as
  `_text_phone` / `_text_consent` (the earlier app's `_ttw_sms_*` are read
  too) and on our booking page, into `set_booking_text_consent`. Bookings →
  Messages sent lists `booking_emails` and `booking_texts`. Keep
  `tests/db/booking-texts.test.ts` passing.
  Order tags in the shop (`lib/bookings/shop-tags.ts`, config `bookings` /
  `shop_tags`, standard words the earlier app's): oversold, needs a date and
  a date we couldn't book, queued once per order and reason
  (`queue_shop_order_tag`, `shop_order_tags`) and added by the worker with
  `tagsAdd` (never removed), tried once. Nothing is queued without the
  optional `write_orders` scope (`private.shop_can_tag_orders` /
  `canTagInShopify`), asked for only from Settings → Bookings → Order tags.
  Keep `tests/db/booking-shop-tags.test.ts` passing.
  Classroom supplies, vendors and the budget (Bookings → Classroom;
  `class_*` and `budget_*` tables, `session_costs`): owners and admins write
  through functions, the team reads supplies, only managers the budget. On
  hand, run-out, order-by, suggested orders and every budget figure are
  worked out on read (`lib/bookings/supplies.ts`, `budget.ts`, whole cents);
  only what a person said is stored (counts, deliveries, corrections,
  orders, costs). Not linked to Stock yet. Keep
  `tests/db/booking-supplies.test.ts` passing.
  Eventbrite (docs/eventbrite.md; Settings → Bookings → Eventbrite, Bookings
  → Eventbrite; gated by the `eventbrite` entitlement): provider
  `eventbrite`, a pasted private token read only through
  `getEventbriteAccess()`, ALL Eventbrite HTTP through
  `lib/eventbrite/client.ts` (plain fetch, reads retried, writes never). As
  in the earlier app, events are made on Eventbrite by hand; we never create,
  publish or cancel one. A date of a workshop switched on
  (`services.eventbrite_on`, off by default) is linked to an event and ticket
  type (`eventbrite_listings`, manager-only `link_session_eventbrite`), and
  its places left (`private.seats_left`) are pushed to that ticket type on
  the once-only pattern (`claim_eventbrite_pushes` / `finish_eventbrite_push`:
  read first, write only what differs, `planTicketClass`; a refusal is tried
  twice more, then a manager's `retry_eventbrite_listing`; unsure is never
  asked again by itself), every five minutes and at once after any booking
  change (triggers). Eventbrite doesn't sign webhooks: each workspace's
  address carries a secret (hash only in `private.eventbrite_hooks`), the
  route queues only the order's number (`enqueue_eventbrite_event`), and the
  worker reads the order from the API and books it with
  `book_from_eventbrite` (lock through `private.lock_seats`, once per order,
  full dates booked and flagged, refunds and fewer tickets follow). Keep
  `tests/db/booking-eventbrite.test.ts` passing.
  The imports' fourth file is the earlier app's message wording
  (`lib/bookings/import/wording.ts`: its messages and fill-ins mapped to
  ours, pure and tested), saved through `save_config` after a preview;
  it fills words only and never becomes our defaults.
- Social: members write posts through `save_social_post`; the worker claims
  due posts (`claim_due_social_posts`) and records each target's answer with
  `finish_social_post`, which merges results so a target that went out is
  never sent twice. A post that is partly or fully out can't be edited, but
  a failed one can be tried again for what didn't go (`retry_social_post`).
  Accounts: one Facebook login holds several Pages, each with its linked
  Instagram account, as `social_accounts` rows (network, platform id, Page,
  brand, in use or not; NO tokens: each Page's token is in Vault beside the
  connection's, read only through `getMetaPageToken`). The login offers them
  (`note_meta_accounts`); an owner or admin chooses which are used and their
  brand (`choose_social_accounts`, Settings → Social accounts), within the
  plan's `social_accounts` limit per network. A post names its `brand_id` and
  `account_ids`; each target is "<account id>:<place>" in `results`, captions
  are per account where they differ, and the places (`channels`) still drive
  every scheduling rule. Posts save through `save_social_post_to` (which calls
  `save_social_post_full`); a caller naming no accounts gets the brand's.
  The composer picks a brand first, then its accounts; the calendar and
  review queue filter by `brand` / `account` in the address. Another network
  is a further `network` value.
  TikTok and LinkedIn (docs/tiktok-linkedin.md) are providers `tiktok` /
  `linkedin`, offered only where their keys are set, ALL their HTTP through
  `lib/tiktok/client.ts` / `lib/linkedin/client.ts` (reads retried, writes
  never). One connection holds SEVERAL logins (a TikTok account, a LinkedIn
  person): tokens under `login:<id>` in the connection's Vault secret, read
  only through `getLoginToken` (`lib/connections/logins.ts`, on top of
  `getProviderToken`, renewing one login under the connection's lock); a
  login that ran out marks its accounts `needs_login`. Accounts carry
  `login_id`; `note_login_accounts` offers them, `forget_social_login` lets
  one login go. Each network's rules are ONE table, `PLACE_RULES` in
  `lib/social/networks.ts` = `private.social_place_rule` (kept equal by
  `tests/db/social-networks.test.ts`), checked in the composer and whenever
  a post becomes scheduled; never per-customer code. TikTok is video only,
  sent as a file; its per-post choices are `social_posts.target_options`
  (`lib/social/tiktok-options.ts`, safe defaults, no privacy chosen for the
  person; "Only you" until `TIKTOK_APP_AUDITED`). Sending once: the worker
  claims only places it can send (`claim_due_social_posts_for`; the older
  `claim_due_social_posts` hands out Facebook and Instagram only), marks a
  target `sending` before the one write (`begin_social_target`), keeps a
  video still being prepared `pending` (asked about, never resent) and a
  lost answer `unsure` (a person settles it, `settle_social_target`); a
  trigger stops anything wiping those. Media only from our own bucket
  (`fetchOwnMedia`). Keep `tests/db/social-networks.test.ts` passing.
  Photos and videos (the Assets tab) sit in the public `social` storage
  bucket under the workspace's id (Instagram fetches by URL). The browser
  sends a file straight to storage with a one-time link from `startUpload`;
  `finishUpload` then checks what really arrived (type, size, path) before
  it is registered, so nothing is trusted from the browser. Folders are one
  level (`social_folders`). A post carries photos or one video on
  its own (`social_posts_photos_only` trigger); the video goes to the Page's
  videos and to Instagram as a Reel, and a Reel still being prepared is
  retried rather than failed. Caption drafts land
  in the caption box and are never scheduled or posted automatically.
  Posts are saved through `save_social_post_full` (up to ten photos in
  order, a caption per channel only where it differs, project, topic); it
  calls `save_social_post`, which still owns the rules about what can be
  scheduled or changed. "Draft the month" writes drafts pencilled in with
  `planned_for`, which is only a note: nothing goes out until a person
  schedules it. The content plan and link page are `configs` (module
  `social`); link-page links are https only. The public `/links/[slug]` page
  reads through `lib/social/links-server.ts`, like the booking pages.
  Review (`social/review`, a menu row with a count): a draft is sent for
  review (`submit_social_post`), sent back with a note or approved, which
  schedules it (`approve_social_post`, "approve all" through the one checked
  `approve_social_posts`). Who approves and whether approval is required are
  the `social` / `review` config (`lib/social/review.ts`, read by the
  database itself; off by default, owners always approve); where it is on a
  trigger refuses any post scheduled without an approver. Approval is always
  a person's press. A carousel's slides stay one design on the post
  (`social_posts.slides`) while it is a draft; scheduling or approving draws
  them in that person's browser (`send-prep.ts`), uploads them through
  `startUpload` / `finishUpload`'s checks and attaches them first
  (`attach_social_slide_pictures`, for that version only: `slides_key`).
  Instagram Stories are a third place (`instagram_story`, one photo or one
  video, `media_type` STORIES, same permission). Every photo's size is read
  by the server from its own bytes (`lib/social/image-size.ts`); one Instagram
  wouldn't take gets a copy cropped from the middle in the browser
  (`lib/social/fit.ts`, pure; `fitted_from` / `channel_media`), the original
  never changes, and the database won't schedule a photo whose stored size
  doesn't fit (`private.social_photo_fits`, kept in step by a test). No image
  library on the server: don't add one. Keep `tests/db/social-review.test.ts`,
  `social-slides.test.ts` and `social-sizes.test.ts` passing.
  The monthly run (`lib/social/month.ts` pure, ported from the Content Hub
  with its tests; `month-run.ts` on the worker): each brand's review day is
  in the plan config (`review_days`, the main brand's names no brand; a
  topic's `from` says "projects" or "claude"; a slot can name its brand).
  OFF by default; `auto` is switched on by owners and admins.
  `claim_social_month_runs` queues once per workspace + brand + month (twin
  of `monthDue`: `private.social_month_due`, held equal by a test), a run
  never finished is marked failed and not re-queued, and "Run it now" is
  `request_social_month_run` through the same unique index. Project times
  get a carousel of up to six photos no post has used (`planProjects`), the
  others a post from the topic; Claude writes with structured output and no
  tools (`month-writer.ts`), its answer only data for `tidyCaption`, and
  `file_social_month_draft` is the ONLY writer: always a draft, waiting for
  review where approval is required. It stops at the AI allowance, posts a
  heads-up and the Review row counts its drafts. Learning from edits:
  `social_post_edits` (before = `ai_draft`, after = the caption, per
  caption) is written ONLY by a trigger on `social_posts`; style notes are a
  config per brand (`social` / `style_notes`, `style_notes-<brand id>`,
  Settings → Social & emails → Style notes), "Suggest notes from my edits"
  only fills the editor, and every caption prompt gets the notes and recent
  edits as data (`learningBlock`). `send-guard.test.ts` keeps models off the
  posting path; keep it and `tests/db/social-month-run.test.ts` passing.
  Every Claude draft goes through `writeDraft` (`lib/social/write-draft.ts`):
  words, or slides where the topic's `makes` is "slides" (`slide-writer.ts`:
  structured output, no tools, photos offered only as `P1`… and checked by
  `tidySlides` against the kit; never an id or address from the model). A
  project's photos are ordered by `taken_at` (read by the server from EXIF,
  `taken-at.ts`, never from the browser), else when added; `role` (finished,
  process, artwork) is a person's mark; photos on slides count as used.
  "Draft from this project" files through `file_social_project_draft`
  (photos re-checked under the project's lock). "Write it again"
  (`redraft_social_post`, refused if the post changed since it was read) and
  "Bring this back" keep the earlier words in `social_post_versions`;
  `ai_draft` is always the draft the person sees. `photos_show` (what Claude
  saw) is kept on the draft and fed to the project's next drafts as data.
  Keep `tests/db/social-drafts-again.test.ts` passing.
- Stock: `stock_items` mirror the shop's variants and are written only by
  the sync (`upsert_stock_items`), which leaves the workspace's own planning
  columns alone. Every reorder figure is worked out on read by the pure
  engine in `lib/stock/engine` (ported from TuftStock with its tests; change
  a formula only with its test) through `buildStockRows()`; nothing derived
  is stored. Sales are matched to an item by SKU, else by product and option.
  A sync only ever reads the shop's count. The one write to a shop is adding
  a checked-in delivery (`stock_receipts` -> worker -> `shopify-stock.ts`):
  add-only, tried once, and refused when the shop has more than one
  location. A delivery is checked in whole through `receive_delivery` with a
  request key, so a second press finds the first. A failed receipt can be
  offered to the shop again only by a manager's press (`retry_stock_receipt`)
  and only when the shop certainly added nothing (`shop_can_retry`; an
  unclear answer is a `StockWriteUnsureError` and is never resent); each try
  has its own key for the shop. A supplier marked "not used any more" gets no
  suggested order anywhere (`hasLiveSupplier`). The sync also writes each
  counted item's count once a day (`stock_daily_counts`, the last look of the
  day, kept 200 days); `loadStock()` reads only the empty days and hands them
  to the engine as `outOfStockDates`, so sold-out days are left out of the
  sales rate. Only the count is stored, never "was sold out". An
  item's cost is `resolveCost()` in `lib/stock/cost.ts`, on whole cents: the
  workspace's own figure (`stock_items.own_cost`, a planning column), else
  the average of checked-in deliveries (summed by `stock_received_costs`,
  divided in the app), else the shop's cost; the average is never stored.
  Planning figures are changed in the grid ("Change figures": one box at a
  time) or for the ticked items, both through `set_stock_items_planning`,
  which changes only the keys it is handed (the older `plan_stock_items`
  overwrites every figure and is not called). An order can carry any planned
  item, whoever usually supplies it; the item keeps its own supplier. Suppliers and orders are
  manager-only; anyone on the team can check a delivery in. Supabase returns 1,000 rows at most, so `loadStock()`
  pages. The shop's vendor on a product becomes a supplier, and items
  with no supplier are filed under it; a supplier chosen by hand is never
  changed by a sync. What is owed to suppliers (Balances tab, owners and
  admins only) is a ledger typed in by hand (`supplier_ledger`: invoices,
  payments, the supplier's own statements, credits). The balance, ageing
  and "marked paid" states are worked out on read by `lib/stock/balance`
  (ported from TuftStock with its tests, on whole-cents `Money`); a
  statement re-anchors the account, and nothing derived is stored. The tab is
  laid out after TuftStock's page (cards, bills by the week due, confirmed
  payments, activity with filters in the URL), with a page per supplier and
  per invoice (`balances/invoice/[id]`); `balance/history.ts` explains the
  ageing (balance after each entry, which payments cleared which bills) and
  never overrules it. Items are
  ordered by the case and can have their own smallest order
  (`engine/case-pack.ts`); name words in settings leave items out as well
  (the two switches a person has are described further down). Drafting orders from ticked items goes through
  `draft_purchase_orders` with a request key, so a second press finds the
  first one's orders. Order totals (shipping, tax, adjustments) come from
  `lib/stock/po/totals.ts`. Tracking on incoming orders
  (`purchase_order_shipments`) is what a person records, plus, for UPS
  numbers (1Z…) in a workspace that has connected its own UPS account for
  real, what UPS says: the worker claims due parcels
  (`claim_po_shipment_checks`: every four hours until delivered, marked as
  here, the order closed or 45 days; sooner on a manager's "Check now",
  `request_po_shipment_check`, once per ten minutes), asks UPS's Track API
  (`trackUps` in `shipping/sources/ups.ts`, through `trackWithUps`, which
  reads the keys from Vault like every other UPS call) and writes down the
  answer with the time asked (`finish_po_shipment_check`, the `carrier_*`
  columns). Those are observed facts kept apart from what a person typed;
  which date to show and "arrived" are decided on read
  (`lib/stock/tracking.ts`: a person's word first, then UPS's). No other
  carrier is asked, a practice UPS connection is never used for tracking,
  and without UPS nothing changes. What is in each parcel is
  `purchase_order_shipment_items` (manager-only `set_po_shipment_items`); it
  is a note and checks nothing in.
  The reorder list (Everything tab) follows TuftStock's: its column names,
  its five views first, dates in its words (`relativeDay`), and its rules for
  dead stock, top sellers and "% Rev" (`topSellerIds`, `isDeadStock`,
  `revenueShare`; revenue is summed on read by `stock_revenue_by_item`). An
  item's photo is the option's own (`variant_image_url`, written only by the
  sync through `set_variant_photos`; the sync asks without photos if the shop
  refuses), else the product's, and is shown only from the shop platform's
  image servers. Saved views are a config (`stock` / `saved_views`), shared by
  the workspace. A purchase order's PDF is words first (`po/document.ts`,
  pure) and then drawn (`po/pdf.tsx`, `@react-pdf/renderer`, server only,
  built-in fonts, with the Noto Sans SC file in `po/fonts/` as the fallback
  for names Helvetica can't draw; no font is ever fetched); the route is
  manager-only, the address is Shipping's ship-from, and the logo is the
  `logo` asset read from our own storage. Every order has a `reference`
  like `KE-202611-A7A950` (TuftStock's scheme: `po/reference.ts`, given by a
  trigger on insert, one of a kind per workspace); it is what people read,
  while the plain `number` still opens the order in its address.
  An order can be emailed to its supplier from the business's own Gmail
  (provider `google_mail`, a `ProviderAdapter` asking only for `gmail.send`;
  offered only where `GOOGLE_MAIL_CLIENT_ID`/`_SECRET` are set;
  docs/gmail-orders.md). It is always a manager's press, after a preview.
  `lib/stock/po/send.ts` is the one path: claim the send under the page's
  request key (`begin_po_email`), draw the PDF, build the message ourselves
  (`po/mime.ts`, no library; headers can't carry a line break), ask Gmail
  once, and write down how it went (`finish_po_email`): sent, failed (Gmail
  said no, so the same press may go again) or unsure (never heard back, so
  nothing is resent without a person). `purchase_order_emails` is that claim
  and the record on the order (when, who, to whom, Gmail's ids, never a
  token). A sent email marks a draft as ordered. "Changed since you emailed
  it" is the stored fingerprint against today's (`po/email.ts`, ported from
  TuftStock with its tests), worked out on read. The starting words are a
  config (`stock` / `po_email`).
  Supplier closures (`supplier_closures`, manager-only functions) are dated
  stretches a supplier is shut. The rule lives in `engine/closures.ts` (pure,
  plain calendar days): an order's lead time may not run through a closure,
  so `buildStockRows()` moves an item's order-by date earlier
  (`row.closure`), works out the order to place before the next closure
  (`row.buildAhead`, sized to last until the first order after they reopen
  could arrive) and `closureOrders()` turns those into the "Order before …"
  cards. Only the dates are stored.
  Spreadsheet imports (Settings → Stock → "Bring your records across",
  manager-only; docs/stock-import.md): the file is read in the browser, sent
  as text and never kept. `lib/stock/import` (pure, tested) reads it and
  reports unusable rows by line; the six `import_*` functions do the writing.
  Each can be run for a look (`p_confirm` false): it does the whole import in
  a block that is then undone and returns the counts, so the preview is the
  import's own answer. A confirmed import needs a request key (logged in
  `stock_imports`, so a second press finds the first), and each file is
  matched against what is here, so the same file again changes nothing.
  Imported history never reaches the shop and never raises `on_hand`: an
  imported order writes `qty_received` on its lines and nothing else
  (`purchase_orders.source = 'import'`), an imported delivery is a
  `stock_receipts` row with `source = 'import'` that a table rule pins to
  `skipped`, and `claim_stock_receipt_tries` skips them as well. Keep
  `tests/db/stock-imports.test.ts` passing when touching receipts. The ledger
  file can say whose word a payment is (`reported_by`) and what is to check;
  `entrySource()` in `lib/stock/balance/source.ts` reads that off the entry
  for the balance (a payment seen from both sides counts once, in the
  history's running balance too: `absorbedPayments`), and a second import
  changes those marks in place on entries a spreadsheet brought.
  Selling seasons are a config (`stock` / `seasons`): a name, an in-stock
  day, an optional lift and how its card sits (open, folded, hidden). The
  rule is `engine/seasons.ts` (ported from TuftStock with its tests): order
  by = in stock by, less the lead time, less the review buffer, one line per
  supplier per lead time; a lift multiplies that month of the seasonal index
  in `buildStockRows()` (only while seasonality is on) and rows bought into a
  busy month carry `peakMark`. An item has two switches: `hidden` (out of
  sight and out of planning) and `dont_reorder` (still listed, never
  suggested; `isListed` against `isPlanned`); a shop tag can switch it off
  too (`stock_items.tags`, written only by the sync through
  `set_stock_item_tags`; the rule is the `skip_tags` setting, applied on
  read). A supplier's `lead_time_days` may be null: it then follows the
  workspace default. The Orders tab (its five views, search, shipping column
  and spreadsheet) is `lib/stock/po/list.ts`. An order's timeline is put
  together on read by `po/timeline.ts` from the tables that already hold
  each fact; `purchase_order_events` holds only what no other table says
  (sent, back to draft, closed, cancelled, renamed, archived, by whom) and is
  written only by a trigger on `purchase_orders`. Renaming, archiving (never
  an order still on its way) and deleting an unused draft are manager-only
  functions. On Balances, notices can be hidden (`stock` / `hidden_notices`;
  a key carries the notice's facts, `balance/notices.ts`), open bills can be
  downloaded as a calendar file (`balance/calendar.ts`; we never reach into a
  calendar), and payments can be read from the books: only when the
  workspace's `payments_from_books` setting is on does the QuickBooks sync
  ask for bill payments and purchases (`quickbooks-payments.ts`, read-only)
  and hand them to `import_book_payments`, which files a payment on the
  supplier of the same name, once (`external_key`), never one already typed
  in, and never one a manager took off (`supplier_ledger_skips`).
  Bills by email (docs/bills-by-email.md; `lib/stock/mail`; set up under
  Settings → Stock → Balances & bills by email, `settings/stock/bills`; the
  working lists are `stock/balances/mail-*`): invoices, statements and
  payment notices are read into the ledger by ONE general reader. Never add
  a parser or a code path for one supplier: who to recognise is a config
  (`stock` / `email_sources`: senders, subject words, a bank's words per
  supplier). Three ways in, one road (`intake.ts`): mail forwarded to the
  workspace's bills address (`bills-<token>@INBOUND_EMAIL_DOMAIN`, the help
  desk's queue; the worker routes it before the help desk and it is never a
  ticket; the token is a secret, never logged), a daily look at Gmail (only
  with the optional `gmail.readonly` scope, recorded in the connection's
  `scopes` and checked on every read; only searches built by `query.ts`
  from the sources, the sender re-checked per message), or an uploaded
  file. Claude reads with structured output and no tools (`reader.ts`); the
  email is marked as material and the answer is only ever data for
  `tidyExtraction`. `plan.ts` (pure) decides skipped and "to check";
  `file_email_entries` is the ONLY writer (same message once, one row per
  invoice number, latest statement wins, removed stays removed). A "to
  check" entry (`needs_review`) counts in the balance, as on TuftStock. A
  message's text and files are never stored: ids, sender, subject and the
  facts only. Everything is capped (`message.ts`) and counted against the
  plan's AI allowance. The help
  desk reads Stock directly, as the member, for "when is this back?"
  (`lib/stock/restock.ts`); the workspace home card does the same for its
  facts (`lib/stock/home-summary.ts`, good news only).
- Michaels Marketplace (docs/michaels-connector.md): an optional connection
  (provider `michaels`, a pasted seller key in Vault, read only through
  `getMichaelsAccess()`), gated by the `michaels` entitlement key and shown
  under Stock → Michaels once connected. THIS STAGE CANNOT WRITE, to Michaels
  or to the shop, and that is held in four places: `lib/michaels/client.ts`
  refuses anything but a GET while `MICHAELS_WRITES_ENABLED` is false (a
  constant, with no setting behind it); no code calls a write; the settings
  (`michaels` / `settings`) have one mode, `watch`; and in the database every
  run is `watch_only`, every order `observed`, and every finished run carries
  why nothing could be sent (`michaels_send_blocked`, which never answers
  "free" and answers `unmatched` when more than a tenth of the listings have no
  item). Keep `client.test.ts` and `tests/db/michaels.test.ts` passing; a
  later stage that sends changes those on purpose and must ask
  `michaels_send_blocked` before every send. All Michaels HTTP goes through
  that one client (throttled, reads retried, ids kept as text by `json.ts`).
  The worker claims a look about once an hour per workspace
  (`claim_michaels_runs`; a look that never finishes is marked failed, not
  retried), reads the whole catalog and recent orders, and records listings
  matched to `stock_items` (`lib/michaels/mapping.ts`, ported from TuftStock
  with its tests: a hand pairing first, then exact SKU, then capitals and outer
  spaces ignored; never a guess between two), what it WOULD send
  (`would-send.ts`: the shop's count less the units held back, the shop's
  price to the cent) and orders with their lines. Nothing about a buyer is
  kept. Pairings are manager-only functions; the whole team can look.
- Shipping: `shipping_orders` holds what packing needs (address, what's left
  to send), kept apart from `orders` so the sales figures never carry an
  address. It is read from the shop in a separate query that is allowed to
  fail, so a shop that hasn't shared addresses still syncs its sales. When a
  shopper is forgotten or a shop disconnected, triggers blank the address
  there and on `shipments`; keep both tests in `tests/db/shipping.test.ts`
  passing. A parcel is recorded with `record_shipment` (whole team; part
  shipments leave the rest in the queue); undoing one is manager-only. Postage
  can be bought from EasyPost, the business's own UPS account or Redo, each a
  connection like any other with its keys in Vault (read only through
  `getLabelAccess()`), all behind one `LabelSource` interface in
  `src/lib/shipping/sources/` and shown as one price list: a label
  is only ever bought against a quote the server stored for that order
  (`shipping_label_quotes`), and a paid label is written there before the
  parcel is recorded, so it cannot be bought twice or lost. No customs or
  international labels yet. Labels can print straight to a Zebra
  (`lib/shipping/zebra`): which printer is that computer's own choice, kept in
  its browser and never in the database; such a computer asks for ZPL with
  the rate request (`labelFormat`, part of the fingerprint), the browser sends
  it to Zebra Browser Print on localhost, and `mark_label_printed` notes it so
  a second copy is warned about. A label kept as a picture or a PDF is drawn
  for the printer in the browser (`pdfjs-dist`, loaded only when a PDF label
  is printed). A print that fails never touches the
  purchase: the label is already kept. Through the browser, a label kept as
  a picture opens on its own print page (`/api/shipping/label-file/[id]`,
  built by `lib/shipping/label-page.ts`): a 4 × 6 inch sheet with no margin,
  the picture fitted whole and turned only when its header says it is wider
  than tall; its one script runs under a per-response nonce, so keep that
  policy as tight as it is. `?raw=1` is the file. Nothing talks to
  Browser Print except on a person's press (Chrome asks before a page may
  reach apps on the computer): a new computer is switched over by "Look for a
  Zebra on this computer" in Settings → Shipping → Printing on this computer
  (`settings/shipping/printing#printing`), and print
  buttons on a browser-printing computer carry a hint that leads there. On a
  Zebra computer every slip button (`SlipsButton`, `SlipsPagePrint` in
  `print-ui.tsx`) sends straight to the printer; which slips a press means is
  worked out in one place (`slips-data.ts`), what was printed before is asked
  about first (`zebra/reprint.ts`), and what went out is marked printed. Telling the shop a
  parcel went (`shopify-fulfil.ts`) follows the same once-only queue as
  stock receipts. The to-ship queue's views (ready, pickup, priority,
  on hold, international) and "back from hold" are worked out on read by
  `lib/shipping/queue.ts`, so a hold with an end date needs no timer.
  "Needs signature" is the workspace's `signature_over` rule held against
  the sale's total. The list's Box, "Best quote · margin" and address-check
  columns come from `shipping_order_plans`, a cache worked out by
  `lib/shipping/plan.ts` (the usual box unless a person picked one, items
  plus box, salted fingerprints instead of any address) and filled a few
  orders at a time by `planNextOrders` after the list is on screen: a price
  lasts 12 hours or until the order changes, an address is asked about once.
  A list price is only words (no rate id) and never touches
  `shipping_label_quotes`, so it can't be bought: buying is the order page's
  own quote.
  Rules are a config (`shipping` / `rules`, schema and the pure evaluator
  in `lib/shipping/rules.ts`, ported from the help desk with its tests):
  every condition of a rule must match, and for each kind of action (box,
  signature, service, hold) the first matching rule wins. `signature_over`
  still works exactly as before and counts as one more rule after the list.
  One plan decides everything (`planFor` in `plan.ts`), strongest first: what
  a person saved for the order → a rule's box → the packing remembered for
  exactly those items → the box used for the same products in other
  quantities → the usual box. The list, the order page and a bulk run all
  start from it; a person's own choice always beats a rule. A rule's hold is
  shown on read and written once by `hold_shipping_orders_by_rule`;
  `rule_hold_settled_at` (also set by a trigger on any release) means no
  rule holds that order again. Packing memory is `shipping_packings`
  (`lib/shipping/memory.ts`: keys are item code × quantity, no shopper),
  written only by `learn_shipping_packing` after a label for a whole order
  is recorded, and only when the boxes the browser named are exactly what
  was priced. Saved choices (boxes, weights, split, signature, service; never
  an address) live in `shipping_order_plans.saved_choice`
  (`lib/shipping/choices.ts`), saved as the order page changes and cleared
  by "Reset". Buying in bulk (`bulk-actions.ts`, `lib/shipping/bulk.ts`):
  the browser asks for one order at a time, and each goes through
  `quoteRates` and `purchaseLabel` in `label-core.ts`, the same path a single
  label takes (never add a second way to buy). The server re-checks every
  order from what is stored, refuses anything that needs a person, and skips
  an order whose fresh price is far above the list's. A run is recorded in
  `shipping_label_batches` (the Label batches tab); `claim_label_batch_order`
  gives each order one turn per run, and `claim_label_purchase` still refuses
  a second label whatever a run does.
  The shop is kept in step in three more places, each through the same
  once-only queue as "parcel went" (claim, try once, write down what
  happened; a claim never finished is marked failed, not retried), all in
  `shopify-fulfil.ts` and `worker/index.ts`, and none of it ever queued for a
  shop without the write permission (`private.shop_can_fulfil`, the database's
  twin of `canSendInShopify`; a watch-only shop gets `not_allowed` and the
  page says so). Voids: a pushed parcel keeps the shop's fulfilment id
  (`shipments.shop_fulfilment_id`, via `finish_shipment_send_with`);
  `void_shipment` queues `shop_undo_status` for it and every rider, and the
  worker cancels the fulfilment (found by tracking number when no id was
  kept) before it sends anything new. Pickups: `mark_pickup_ready` /
  `mark_picked_up` queue `pickup_ready_shop_status` / `picked_up_shop_status`
  when the `tell_shop_pickups` setting is on (the database reads the config
  itself); a step the shop has heard is never told twice, and there is no
  un-telling. Words for these statuses live in `lib/shipping/shop-steps.ts`.
  Part of an order with a bought label (`?part=` on the order page,
  `lib/shipping/part.ts`): the quote keeps which items and how many
  (`shipping_label_quotes.part_items`, written only by
  `save_part_label_quote` after checking them against the order),
  `record_label_shipment` records exactly those and then holds what's left
  ("Part sent — waiting on: …") unless `hold_rest` was unticked; quantities
  are never taken from the browser at buying time, and packing isn't learned.
  Scan & pack (`scan/pack-station.tsx`, laid out like the help desk's bench)
  prices the planned label as the order opens and buys it from there
  (`scan-actions.ts`): `benchAssess` in `planned.ts` builds the one request,
  for the whole order, for only what was scanned (`part`, through
  `save_part_label_quote`) or for orders going together (`withIds`), on top
  of the `assess` and `planInput` bulk runs use, and the purchase is still
  `purchaseLabel`. The bench's box row and "Change boxes" (add or remove a
  box, move items; rules in `lib/shipping/scan.ts`, ported from the help
  desk's label builder) are checked on the server against the stored order
  and kept as the order's `saved_choice`; once labels are bought the boxes
  are fixed. "Print the label as soon as every item is scanned" is that
  computer's own tick (`autoPrint`, in its browser like the printer), and
  only a real finishing scan sets it off (`autoPrintNow`). The rate
  calculator (`rates/`, `lib/shipping/rate-calc.ts`) asks the sources through
  `listRates`: words only, no rate id, nothing in `shipping_label_quotes`.
  The packing slip's layout is a config (`slip_layout`) with a designer and
  live preview (`slip-designer.tsx`); its barcode (`code128.ts`) is what
  Scan & pack reads. A slip is laid out in one place only, `slip-sheet.tsx`
  with its own stylesheet (`lib/shipping/slip-css.ts`: no Tailwind, no app
  fonts, nothing fetched), from the words `buildSlipData` works out: the
  screen and paper (4 × 6 or letter, per computer) show it, and a Zebra
  prints that same sheet as a picture (`slip-zebra.tsx`,
  `zebra/slip-draw.ts`, the arithmetic in `zebra/raster.ts`) with the
  barcode laid down again at whole dots. `slipZpl` is only the way out when
  a browser can't draw it. The logo is the `logo` asset from our own
  storage; item photos print on paper only. Slip codes and boxes are `lib/shipping/slip-boxes.ts`
  (ported from the help desk with its tests): the code is the order's name
  without "#"; an order in two or more filled boxes gets one slip per box
  (`<code>/B<n>`, "Box n of m", only that box's items) on screen
  and on the Zebra alike; a group's one slip
  carries the numbers joined with "+". Before buying, the boxes are the plan's
  (`plannedBoxes` in `slips-data.ts`, nothing stored); after, what went in
  each box is the note `shipments.box_items`, written only by the server
  (`note_shipment_boxes`, from `purchaseLabel`) and only when it is true of
  the parcel. The bench reads a code with `parseSlipCode` (the whole code as
  an order's name first, then a box of the shorter one; "/", "-", "?" and a
  space all read as the box separator), packs a box from the box's own
  numbers, buys every box's label in one purchase and prints one box's at a
  time (`mark_label_box_printed`, `label_boxes_printed`). Those two columns
  are read in a query of their own that is allowed to fail
  (`loadParcelBoxes`). Packing details are asked of the shop ten orders at a
  time, and without delivery methods if the shop won't share them.
  Ship together: orders for the same person and address can go on one label
  (`lib/shipping/merge.ts`; the database has the same address rule in
  `private.shipping_address_key`, and a test keeps the two in step). The
  label is bought on the oldest order (`/orders/[id]?with=`), its quote
  remembers the others (`rider_ids`), `claim_group_label_purchase` locks and
  checks every order, and `record_label_shipment` writes one `shipments` row
  per order in one transaction (riders point at the label's parcel with
  `merged_with`, carry no cost, and are undone only by voiding that parcel).
  `shipping_groups` holds only what people decided before buying (saved,
  "not now", approved as one place).
- Setup: a tool's "finish setting up" checklist, card and guided page follow
  docs/setup-pattern.md (`lib/setup/`, `components/setup/`): items worked
  out on read, only "Not now" stored, steps write through existing paths.
  Money, Stock (`lib/stock/setup.ts`, `stock/setup`), Shipping
  (`lib/shipping/setup.ts`, `shipping/setup`), Bookings, the help desk and
  Social (`lib/<tool>/setup.ts`, `<tool>/setup`) have one; optional items
  never show on the card, owners-and-admins items say "Ask an owner or
  admin" to anyone else, and every tool's "Not now" but Money's is readable
  by its team. The help desk has no card (the inbox is three panes): its
  Set up row carries the count. A theme snippet we can't see is never
  "done" without a real signal; the automatic reply and the monthly run are
  only linked, never written or switched on. Keep
  `tests/db/setup-not-now.test.ts` passing.
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
- Brand kit: a workspace has one or more brands (`brands`: name, slug, main
  or not, put away or not; never deleted, and posts, accounts and emails point
  at them). Each brand's colours and voice are a config (module `brand`, key
  `kit` for the first brand, `kit-<brand id>` for the others, schema in
  `lib/brand/kit.ts`, written through `save_brand_kit` → `write_config`, so
  the assistant can propose any of them), read with `loadBrandKit()` (the
  main brand unless one is named); set up under Settings > Brand kit, where a
  new workspace lands first and where brands are added, renamed, made main
  and put away (owners and admins; the plan's `brands` limit). Claude can suggest one from
  five answers or read one out of an uploaded guide (`lib/brand/draft.ts`);
  the suggestion only fills the editor and is saved when a person presses
  save. `brandBrief()` puts the kit into drafting prompts as data;
  `toDesignKit()` turns it into the kit the email and slide designs draw
  with, choosing text colours by contrast. We never fetch a brand's website.
  How a workspace looks is a second config (`brand` / `appearance`): light,
  dark or the device's choice, set as `data-theme` on the workspace wrapper
  (`.tuft-scope` in `globals.css`), and optionally the kit's colours on the
  menu and the filled button (`brandThemeVars`, which keeps them readable);
  it is set under Settings → Look.
  Pages outside a workspace are always light.
- Emails: a marketing email is a document (`emails.doc`, the model in
  `lib/design`, ported from the Content Hub with its tests) edited in the
  drag-and-drop builder (`components/email-builder`, opened at
  `w/[slug]/emails/[id]`). The builder knows nothing about the database: the
  page hands it a `BuilderHost` of server actions. Every save runs
  `normalizeDoc` on the server before `save_email`. Starters are the
  built-in templates recoloured to the workspace's brand kit
  (`lib/brand/email.ts`). We don't send email: the person copies the HTML
  into their own email tool. Saved sections and templates are `configs`
  (module `social`), so only owners and admins can change them. Pictures
  with words on them (email banners, slides for posts) are made in the
  designer (`components/slides`, drawn in the browser with the workspace's
  kit and the app's own fonts) and uploaded as ordinary assets with their
  design kept beside them (`social_assets.design`) so they can be reopened.
  Photos are matched to drafts by asset tags (`lib/social/photo-match.ts`);
  `logo` and `logo-light` tags are the email logo. The one thing the server fetches is a
  product's main photo, whose address the shop sync gave us, and only from
  the shop platform's image servers (`shopPhotoAddress()` in
  `lib/social/product-photos.ts`); a person copies those into Assets from
  the Assets page, once per product (`source_ref`). Nothing a person types
  is ever fetched. Not built yet: live link checking.
- Platform admin: `/admin` is for the people who run the suite, apart from
  any workspace role (docs/admin.md). Who is one is a hand-kept list
  (`private.platform_admins`; no screen adds to it). The pages call
  `admin_*` database functions with the admin's own session, never the
  service role; each checks `private.is_platform_admin()` itself, and the
  pages answer "not found" to anyone else. Those functions return how a
  workspace is running (plan, connections, jobs, counts) and never what its
  customers wrote or bought; `tests/db/platform-admin.test.ts` pins the
  field list, so widen it on purpose. The only writes are an internal plan
  and "sync again", each leaving a `private.admin_audit` row. An internal
  plan (`plan_grants`, no client access) sits in front of Stripe while it
  runs: `resolveEntitlements(subscription, grant)` is still the one place
  that decides, members read their grant through `workspace_plan_grant()`,
  and nothing ever writes `subscriptions` for it.
- Settings: every tool's settings live in ONE place, workspace Settings
  (`w/[slug]/(app)/settings/**`), never inside the tool. Its list of sections
  is one data model, `settingsNav()` in `lib/settings/nav.ts` (groups →
  sections → a tool's screens, with who sees each and the search words);
  the navigation model turns it into the Settings menu, so Settings is drawn
  by the same panel as every tool.
  A new settings screen means a page under `settings/<tool>/…`, an entry
  there, and `<SectionHeading back=…>` at its top so there is a way back to
  the tool. The pages import the tool's own forms, actions and gate from the
  tool's folder (those didn't move), and each still checks for itself who may
  open and change it; the list only hides what a person can't use. A tool's
  menu panel ends in "Settings", which opens that tool's section.
  Tools with nothing to set (Social, Money, Messages, Assistant) have a short
  "where to change things" page. Work stays in the tool: the content plan,
  the link page, Michaels pairing, the bills "to check" list, label batches.
  Old addresses (`shipping/settings`, `stock/settings`, …) are sent on for
  good by the proxy from the list in `lib/settings/redirects.ts`; Shipping's
  old anchors are read in the browser (`ShippingAnchorForward`). Tool actions
  revalidate `/w/<slug>/settings` as well as their own tool.
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
- Navigation: two things sit left of every workspace page, both drawn by
  `w/[slug]/layout.tsx` from ONE model, `buildNav()` in `lib/nav/model.ts`
  (pure, tested: tools by plan and role through `entitlements.can`, each
  tool's menu as groups → rows, which row is lit for an address). The hub
  rail (`components/shell/hub-rail`) is tools only and never changes between
  tools: an icon each, named for screen readers and on hover, the current one
  in ochre. A tool's own places live in the menu panel beside it
  (`components/shell/menu-panel`): add a place by adding a row to the model,
  and never add a tab row for a tool's sections (`<SectionTabs>` is only for
  switching views of one page). The panel sits beside the page from 1024px,
  can be folded away (the `mbs-panel` cookie, read by the layout so nothing
  jumps on load), and under that width opens over the page from the menu
  button `<PageHeader>` carries (`<PanelButton>`; a full-window page puts
  one in its own header). Counts in the model are only ones the layout
  already has (`loadAttention`); a page that has worked out more hands them
  over with `<PanelExtras>`. Messages draws its own conversation list in the
  panel's place with the panel's classes (`panel: "page"`); Home and the
  email builder have no panel; Connections shows the Settings menu. A page's
  title is the name of its place ("Suppliers"), not of its tool.
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
