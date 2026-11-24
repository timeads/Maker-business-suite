# Bringing stock records in from spreadsheets

Stock → Settings → **Bring your records across** takes CSV files and turns them into suppliers, planning figures, purchase orders, supplier accounts and history. It is for owners and admins.

This page says exactly what each file needs, and how to get each one out of TuftStock. Nothing has to be added to TuftStock: every file is one query against its database.

## How an import works

1. Pick what is in the file, then the file. It is read in your browser and sent as text; the file itself is never kept.
2. You are shown what it would do: how many are new, how many would change, how many are already as the file says, and every row that was left out, by line number, with the reason. Nothing has been saved at this point. (The database works the numbers out by doing the whole import and undoing it, so they are exact.)
3. Press **Bring these in**. If your records changed between looking and pressing, nothing is saved and you are shown the new picture instead.

Things that hold for every file:

- **Twice is the same as once.** A second press of the button does nothing, and bringing the same file in again later changes nothing.
- **A bad row never stops a good one.** Rows that can't be used are left out and listed. Fix them in the file and bring it in again; the rows already in aren't added twice.
- **History is only history.** A purchase order that says goods have arrived, and a past delivery, never raise a count in the app and are never sent to your shop. They are marked as imported, and the part of the app that talks to your shop cannot pick them up.
- **Limits.** A file can be 4 MB at most. Rows per file: suppliers 2,000; daily counts 20,000; everything else 10,000. Split a bigger file and bring the parts in one at a time.
- **Format.** CSV with the column names on the first line. Capitals and spaces in column names don't matter (`Lead Time Days` is `lead_time_days`), the order of columns doesn't matter, and columns that aren't listed here are ignored. Commas, semicolons or tabs between cells all work. Dates are `2026-03-04`, `3/4/2026` (month first) or `2026-03-04T15:20:00Z`. Yes/no cells take `yes`, `no`, `true`, `false`, `t`, `f`, `1`, `0`. Money takes `1200.50`, `$1,200.50`.

**Bring the files in this order.** Later ones lean on earlier ones.

| #   | File            | Why this place in the order                                                      |
| --- | --------------- | -------------------------------------------------------------------------------- |
| 0   | (your shop)     | Connect your shop and let it sync first: items are matched to what the shop has. |
| 1   | Suppliers       | So lead times and contacts are right before anything names a supplier.           |
| 2   | Item planning   | Hands each item to its supplier.                                                 |
| 3   | Purchase orders | Needs the items; adds any supplier it names that is still missing.               |
| 4   | Past deliveries | Each is matched to an order from step 3.                                         |
| 5   | Supplier ledger | Independent of the orders; needs only the suppliers.                             |
| 6   | Daily counts    | Independent; needs only the items.                                               |

**How rows find their item.** By `sku` first (capitals don't matter). When a row has no SKU, or no item has it, by `product` and `option` together. If two items share a SKU and the product and option don't settle it, the row is left out rather than guessed at.

## Getting the files out of TuftStock

TuftStock has no export buttons for these, so each file is a query run against its Postgres database (the one in its `DATABASE_URL` / `DIRECT_URL`). Two ways to run one:

- **Supabase's SQL editor**: paste the query, run it, and use _Export → Download CSV_.
- **psql**, with the direct (port 5432) address: `\copy ( <query without the final semicolon> ) to 'suppliers.csv' with (format csv, header)`

The queries only read. TuftStock's tables are named as in its `prisma/schema.prisma`, which is why the names are in double quotes. Its timestamps are stored in UTC.

---

## 1. Suppliers

| Column               | Needed | What goes in it                                                                                |
| -------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `name`               | yes    | The supplier's name. This is how rows are matched (capitals don't matter).                     |
| `contact_name`       |        | Who an order is addressed to.                                                                  |
| `contact_email`      |        | One address or several, separated by `;` or `,`. The first is the main one. Six at most.       |
| `lead_time_days`     |        | 0 to 365. Empty leaves the supplier's lead time as it is (30 for a new one).                   |
| `coverage_days`      |        | 1 to 365. Empty leaves it.                                                                     |
| `moq`                |        | Smallest order, 1 or more. Empty leaves it (1 for a new one).                                  |
| `moq_applies_to`     |        | `ORDER` or `SKU`. Empty leaves it (`ORDER` for a new one).                                     |
| `payment_terms_days` |        | 0 to 365. Empty leaves it (30 for a new one).                                                  |
| `notes`              |        | If the file has this column, it replaces the notes (an empty cell clears them).                |
| `archived`           |        | `yes` marks the supplier as not used any more; `no` brings one back. Empty leaves it as it is. |

Also accepted as column names: `emails` or `email` for `contact_email`.

From TuftStock:

```sql
select s.name,
       s."contactName"  as contact_name,
       s."contactEmail" as contact_email,
       s."leadTimeDays" as lead_time_days,
       s.moq,
       s."moqAppliesTo" as moq_applies_to,
       a."paymentTermsDays" as payment_terms_days,
       s.notes,
       s.archived
from "Supplier" s
left join "VendorAccount" a on a."supplierId" = s.id
order by s.name;
```

## 2. Item planning

| Column           | Needed       | What goes in it                                                     |
| ---------------- | ------------ | ------------------------------------------------------------------- |
| `sku`            | one of these | The item's SKU in your shop.                                        |
| `product`        | one of these | The product's name, for items with no SKU.                          |
| `option`         |              | The option's name (size, colour), read together with `product`.     |
| `supplier`       |              | Who it comes from. Empty leaves the item with whoever it has.       |
| `supplier_sku`   |              | What the supplier calls it.                                         |
| `own_cost`       |              | Your own cost for one, when you know better than the shop's figure. |
| `lead_time_days` |              | This item's own lead time, 0 to 365.                                |
| `coverage_days`  |              | This item's own days of cover, 1 to 365.                            |
| `safety_stock`   |              | Spare units to keep.                                                |
| `moq`            |              | This item's own smallest order.                                     |
| `case_pack`      |              | Units in a case. 1 means it is ordered in single units.             |
| `dont_reorder`   |              | `yes` stops suggestions; the item stays in the lists.               |
| `hidden`         |              | `yes` takes it out of the lists and out of planning.                |

Apart from `supplier`, **a column that is in the file is applied to every row**: an empty cell clears that figure (back to the supplier's own, or to none). **A column that isn't in the file is left alone.** So to set only case sizes, bring in a file with only `sku` and `case_pack`.

A supplier named here counts as chosen by hand: a later sync with your shop never changes it. A supplier that doesn't exist yet is added.

Also accepted: `primary_supplier`, `lead_time_override`, `case_pack_size` and `cost`.

From TuftStock:

```sql
select v.sku,
       v.title                  as product,
       v."optionLabel"          as option,
       s.name                   as supplier,
       v."supplierSku"          as supplier_sku,
       v."avgCostOverride"      as own_cost,
       v."leadTimeOverrideDays" as lead_time_days,
       v."coverageDaysTarget"   as coverage_days,
       v."safetyStockUnits"     as safety_stock,
       v.moq,
       v."casePackSize"         as case_pack,
       v."dontReorder"          as dont_reorder,
       v.hidden
from "Variant" v
left join "Supplier" s on s.id = v."primarySupplierId"
where v."discontinuedAt" is null
order by v.title, v."optionLabel";
```

TuftStock also switches reordering off by tag or collection (`dontReorderAuto`). That is left out on purpose: here the same job is done by the words under Stock → Settings → "Never plan for".

## 3. Purchase orders

One row for each line of each order. Rows with the same `reference` make one order; what is said once for the whole order (supplier, dates, shipping, tax, adjustments, notes) is taken from the first row that says it.

| Column          | Needed       | What goes in it                                                                                |
| --------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| `reference`     | yes          | The order's name, 3 to 40 characters. It is kept exactly.                                      |
| `supplier`      | yes          | Who it was placed with. Added if not here yet.                                                 |
| `status`        |              | `DRAFT`, `ORDERED`, `PARTIAL`, `CLOSED` or `ARCHIVED`. Empty and it is worked out (see below). |
| `created_at`    |              | When it was started.                                                                           |
| `sent_at`       |              | When it was sent to the supplier.                                                              |
| `expected_at`   |              | When it is due.                                                                                |
| `closed_at`     |              | When it was finished.                                                                          |
| `sku`           | one of these | The item's SKU.                                                                                |
| `product`       | one of these | The product's name (`title` is accepted too).                                                  |
| `option`        |              | The option's name.                                                                             |
| `qty_ordered`   | yes          | How many were ordered.                                                                         |
| `qty_received`  |              | How many had arrived.                                                                          |
| `unit_cost`     |              | Cost of one.                                                                                   |
| `supplier_sku`  |              | The supplier's code on this line.                                                              |
| `line_note`     |              | A note on this line.                                                                           |
| `shipping_cost` |              | Shipping for the whole order.                                                                  |
| `tax_rate_pct`  |              | Tax, as a percentage of the items.                                                             |
| `adjustments`   |              | Other amounts on the order: `Label=12.50; Another=-3.00`. Twelve at most.                      |
| `notes`         |              | The order's note.                                                                              |

What happens:

- **An order whose reference is already here is left exactly as it is.** That is what makes a second import harmless. To correct an imported order, change it in the app.
- **Status.** `ARCHIVED` becomes "closed" if anything had arrived and "cancelled" if nothing had. Between "ordered" and "part received" the quantities have the last word. With no status: never sent → draft; sent and nothing in → ordered; some in → part received; all in → closed.
- **What had arrived is written on the order's lines and nowhere else.** No count goes up, no delivery is recorded, and nothing is queued for your shop. For an order that is still open, what is still to come can be checked in as usual, and only that is added.
- **A line whose item isn't in your shop any more** can't be kept as a line. Its cost is kept on the order as one adjustment ("Items no longer in your shop"), so the order's total and your Spend figures still add up. Each such line is listed in the preview.
- **The same item twice on one order** becomes one line at the average cost.
- Imported lines count toward an item's average cost of deliveries straight away.

Also accepted: the column names of the Monocle export TuftStock's own importer reads (`PO Number`, `Date Placed`, `Expected Delivery Date`, `Product`, `Variant`, `Confirmed Qty` / `Ordered Qty`, `Received Qty`, `Confirmed Cost` / `Unit Price`).

From TuftStock:

```sql
select po.reference,
       s.name    as supplier,
       po.status,
       to_char(po."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
       to_char(po."sentAt",    'YYYY-MM-DD"T"HH24:MI:SS"Z"') as sent_at,
       to_char(po."expectedAt", 'YYYY-MM-DD')                 as expected_at,
       to_char(po."closedAt",  'YYYY-MM-DD"T"HH24:MI:SS"Z"') as closed_at,
       coalesce(v.sku, li."skuSnapshot")     as sku,
       coalesce(v.title, li."titleSnapshot") as product,
       v."optionLabel"   as option,
       li."qtyOrdered"   as qty_ordered,
       li."qtyReceived"  as qty_received,
       li."unitCost"     as unit_cost,
       li."supplierSku"  as supplier_sku,
       li.note           as line_note,
       po."shippingCost" as shipping_cost,
       po."taxRatePct"   as tax_rate_pct,
       (select string_agg(replace(replace(a.label, ';', ','), '=', '-') || '=' || a.amount, '; ' order by a.id)
          from "PoAdjustment" a where a."poId" = po.id) as adjustments,
       po.notes
from "PurchaseOrder" po
join "Supplier" s on s.id = po."supplierId"
join "PoLineItem" li on li."poId" = po.id
left join "Variant" v on v.id = li."variantId"
order by po."createdAt", po.reference, li.id;
```

That is every order. To bring across only the ones still open, add `where po.status in ('ORDERED', 'PARTIAL')` before `order by`.

## 4. Past deliveries

When goods on an imported order arrived. This is what "how long does this supplier really take" is worked out from. It is history only: it adds nothing to a line or a count (how many arrived is already in the orders file) and is never sent to your shop.

| Column        | Needed       | What goes in it                                  |
| ------------- | ------------ | ------------------------------------------------ |
| `reference`   | yes          | The order it arrived on.                         |
| `sku`         | one of these | The item's SKU.                                  |
| `product`     | one of these | The product's name.                              |
| `option`      |              | The option's name.                               |
| `quantity`    | yes          | How many arrived, 1 or more.                     |
| `received_at` | yes          | The day, or the day and time. Not in the future. |

A row is kept only when an order **brought in from a spreadsheet** has that reference and has that item on it. Others are counted as "left out" in the preview. Bring the orders in first.

From TuftStock (each time a delivery was checked in, it wrote down which SKUs and how many):

```sql
select po.reference,
       l.value ->> 'sku'          as sku,
       (l.value ->> 'qty')::int   as quantity,
       to_char(e."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as received_at
from "PoEvent" e
join "PurchaseOrder" po on po.id = e."poId"
cross join lateral jsonb_array_elements(e.detail -> 'lines') as l(value)
where e.type = 'RECEIVED'
  and l.value ->> 'sku' is not null
  and (l.value ->> 'qty')::int > 0
order by e."createdAt";
```

Orders that TuftStock itself imported from Monocle have no such record, so they bring no deliveries; that is expected.

## 5. Supplier ledger

For the Balances tab. Entries are marked as imported.

| Column           | Needed | What goes in it                                                                                                |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `supplier`       | yes    | Whose account it is. Added if not here yet.                                                                    |
| `type`           | yes    | `STATEMENT`, `INVOICE`, `PAYMENT` or `ADJUSTMENT`.                                                             |
| `entry_date`     | yes    | The date on it. From 2000, and no more than a year ahead.                                                      |
| `amount`         |        | Needed for an invoice or payment (more than zero) and for an adjustment (a credit in your favour is negative). |
| `stated_balance` |        | Needed for a statement: what the supplier says is owed that day (negative when you are in credit).             |
| `reference`      |        | Invoice number or payment reference.                                                                           |
| `description`    |        | A note.                                                                                                        |
| `paid_on`        |        | For an invoice you had ticked "Paid" before the payment showed up: when.                                       |

What happens:

- An **invoice or payment that has a reference** corrects the entry on that supplier's account with the same reference (date, amount, note), exactly as typing it in again would.
- **Anything else** is added unless the very same entry is already there. Two identical rows in one file (two payments of the same amount on the same day) make two entries, once.

From TuftStock (entries a later email corrected are left behind):

```sql
select s.name as supplier,
       e.type,
       to_char(e."entryDate", 'YYYY-MM-DD') as entry_date,
       e.amount,
       e."statedBalance" as stated_balance,
       e.reference,
       e.description,
       to_char(e."paymentSentAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as paid_on
from "VendorLedgerEntry" e
join "VendorAccount" a on a.id = e."accountId"
join "Supplier" s on s.id = a."supplierId"
where e."supersededById" is null
order by s.name, e."entryDate", e."createdAt";
```

Entries TuftStock had flagged for a second look (`needsReview`) come across like any other; check those accounts on the Balances tab afterwards.

## 6. Past daily counts

What was on the shelf on past days. The app writes a count down each day from now on, but starts with none, so until then no day counts as "sold out". This fills the gap.

| Column    | Needed       | What goes in it                           |
| --------- | ------------ | ----------------------------------------- |
| `sku`     | one of these | The item's SKU.                           |
| `product` | one of these | The product's name.                       |
| `option`  |              | The option's name.                        |
| `date`    | yes          | The day.                                  |
| `on_hand` | yes          | The count that day (may be zero or less). |

What happens:

- Only days in the last 200 are kept (no sum looks further back). Today and later are left out: today's count comes from your shop.
- **A day the app already has a count for keeps the count it has.** What was seen here wins.
- Nothing else changes: not the item's count today, not anything in your shop.

The only days the sums use are the ones with nothing on the shelf, so the query below brings just those. That keeps the file small.

From TuftStock:

```sql
select v.sku,
       v.title          as product,
       v."optionLabel"  as option,
       to_char(d.date, 'YYYY-MM-DD') as date,
       d."stockOnHand"  as on_hand
from "StockDaily" d
join "Variant" v on v.id = d."variantId"
where d.date >= current_date - 200
  and d."stockOnHand" <= 0
  and v."discontinuedAt" is null
order by d.date, v.sku;
```

(TuftStock began writing these down on 15 September 2026, so there is nothing earlier to bring.)

## What isn't brought across

- **Sales history.** It comes from your shop when it syncs.
- **Tracking numbers on incoming orders.** Add the ones still on their way by hand on each open order.
- **Saved views, seasons, and email templates.** Set these up again in the app.
- **Anything about the Michaels connector.**

## After bringing everything in

1. Stock → Suppliers: check lead times and smallest orders.
2. Stock → Everything: the supplier column should be filled in; "No supplier" should hold only what you expect.
3. Stock → Orders: open orders should match the ones you are waiting on, and the "on order" figures in the list with them.
4. Stock → Balances: each supplier's balance should match TuftStock's.
5. Put the two reorder lists side by side for a few days before relying on the new one.
