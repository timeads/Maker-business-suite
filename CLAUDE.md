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
  by `inView()` in `lib/helpdesk/views.ts`, so a snooze needs no timer. The
  folders and tags are rows in the help desk's menu panel (the nav model
  builds their addresses); the inbox hands the panel the counts and tags it
  has already read (`<PanelExtras>`) and never runs a query for them. Notes
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
  database; the worker only adds the words. A tool's several places are
  rows in its menu panel (`lib/nav/model.ts`), not tabs.
  A workshop can instead be sold through the business's own shop
  (`services.shop_product_id`): the date picker on the product page
  (`public/booking-widget.js`, plain JS in a shadow root, reads
  `/api/book/shop`) puts the date on the cart line as "Session ID", the
  shop takes the payment, and the order sync turns it into a booking with
  `book_from_shop` (once per order and date; the seats follow refunds; a
  full or closed date is still booked and flagged). Such a workshop can't
  be booked or paid for on our own pages.
- Social: members write posts through `save_social_post`; the worker claims
  due posts (`claim_due_social_posts`) and records each channel's answer with
  `finish_social_post`, which merges results so a channel that went out is
  never sent twice. A post that is partly or fully out can't be edited.
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
  `tests/db/stock-imports.test.ts` passing when touching receipts.
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
- Brand kit: each workspace's colours and voice are one config (module
  `brand`, key `kit`, schema in `lib/brand/kit.ts`), set up under Settings >
  Brand kit, where a new workspace lands first. Claude can suggest one from
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
