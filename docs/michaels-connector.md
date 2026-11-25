# Michaels Marketplace connector

An optional connection for any workspace that sells on Michaels Marketplace. It is being built in stages. **The first stage is in the suite and only watches: it cannot write to Michaels or to the shop.**

The connector is a port of the one that runs for real inside TuftStock (the owner's single-tenant app; `src/lib/michaels/` and `docs/08-michaels-connector.md` there). Everything known about Michaels' API comes from that working code and its notes. Nothing here was run against the real Michaels API from the suite: see "Not checked against the real Michaels" below.

## 1. What this stage does

1. **Connect.** Connections has a "Michaels Marketplace" card. The owner pastes an API key, types the day it was made, and picks the real marketplace or the sandbox. The key is checked with one small read (`GET /listing/all-listings?limit=1`) and kept in Vault as the connection's token. Michaels has no call that says when a key ends, so the countdown runs from the day typed: keys end at 90 days and tend to misbehave in their last 30, so the connector counts down to day 60 (TuftStock's rule) and posts a heads-up in Messages at 14, 7, 3 and 1 days, when it's due, and if it runs out.
2. **Match listings.** Each look reads the seller's whole catalog and matches every sellable Michaels SKU to a stock item, in this order: a pairing typed in by hand; the same SKU exactly; the same SKU with capitals and outer spaces ignored; the same barcode. A rule only counts with exactly one hit; two or more is "more than one match" and is left for a person. The same seller SKU on two Michaels listings matches the first and reports the second.
3. **Watch stock and prices.** For every matched listing the look works out the stock it would send (the shop's count, less the units held back, never below zero) and the price (the shop's, to the cent; a missing or zero price is never sent), compares them with what Michaels shows now, and writes down the differences.
4. **Orders, read only.** The look reads recent orders (30 days of ones still to ship, 7 days of finished ones) and keeps each order's number, status, dates, totals and lines. The Orders tab shows what bringing each into the shop would make, all or nothing: one unknown SKU and the order "couldn't be brought in yet".
5. **Pages** under Stock → Michaels (the tab appears once Michaels is connected): Overview, Listings, Would send, Orders. Its settings are under workspace Settings → Stock → Michaels (the gear at the end of the Michaels tabs). The whole team can look; pairing, settings and "Look now" are for owners and admins.

### The safety stop

If more than a tenth of the Michaels SKUs have no item, nothing may be sent. In this stage nothing can be sent anyway, but the rule is already enforced where a later stage will have to ask:

- `public.michaels_send_blocked(tenant)` works the answer out from the listings themselves each time: `no_scan`, `unmatched` (more than a tenth), or `watch_only`. It never answers "free to send" in this stage.
- `finish_michaels_run` stamps every finished look with that answer, taken from the database and not from the worker, and a check on the table refuses a finished look without one.
- `adoptionBlocked()` in `src/lib/michaels/mapping.ts` is the same rule for the pages. `tests/db/michaels.test.ts` holds the two to the same line (exactly a tenth is allowed; one more is not).

### How "cannot write" is held

| Where                        | What stops a write                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/michaels/client.ts` | Anything but a `GET` is refused before a request is built, while `MICHAELS_WRITES_ENABLED` is false. It is a constant: no setting, flag or environment variable is behind it.                                                           |
| The code                     | No write function was ported. `api.ts` has reads only. A test reads the source of every Michaels file and the worker and fails if any asks the client for anything but a `GET`, calls `fetch` outside the client, or sets the constant. |
| The settings                 | `mode` has one value, `watch`. A stored body asking for anything else doesn't parse and the connector reads as switched off. There is nowhere to keep a "go live" switch or a cut-over time yet.                                        |
| The database                 | Every run is `watch_only` (a check); every order is `observed` (a check; there are no columns for a shop order); every finished run says why nothing could be sent.                                                                     |
| The shop                     | Nothing in the connector talks to the shop at all. It reads `stock_items`, which the ordinary shop sync fills.                                                                                                                          |

A later stage that sends must change the constant and those tests on purpose, and ask `michaels_send_blocked` before every send.

### What is read from Michaels, and how often

One look per workspace about once an hour while switched on, plus "Look now" (at most one every ten minutes). Calls are one at a time, at least 250 ms apart, with a 30 second limit each; a read that fails with a 429 or 5xx is tried again up to four times with a growing wait.

| Call                                                                                    | When                                                                      | How many                                                                                                                           |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /listing/all-listings?limit=100&cursor=…`                                          | Every look                                                                | One per 100 listings (up to 300 pages)                                                                                             |
| `GET /listing/inventory/{primarySkuNumber}` and `GET /listing/price/{primarySkuNumber}` | Only for matched listings whose stock or price wasn't in the catalog read | At most 25 listings a look (50 calls), longest-unknown first                                                                       |
| `GET /order/query`                                                                      | Every look, if Orders is on                                               | One request per status, 7 statuses; a second request (page 0) for a status whose page 1 was empty; more pages only past 200 orders |
| `GET /listing/all-listings?limit=1`                                                     | Once, when connecting                                                     | 1                                                                                                                                  |

### What is kept

`michaels_listings` (the map, with what Michaels showed), `michaels_pairings` (typed in by hand), `michaels_runs` (each look: counts and up to 500 would-be changes; looks are forgotten after sixty days), `michaels_orders` and `michaels_order_lines`, `michaels_alerts` (heads-ups already posted). Every table has `tenant_id` and row security; members read their own workspace's rows and nobody writes except through the functions in `supabase/migrations/20270102000100_michaels.sql`. **No buyer's name, phone or address is kept.** Shipments and returns have no tables yet: they come with the stages that use them.

### Different from TuftStock, on purpose or for now

- **A hand pairing wins.** In TuftStock a typed alias is tried last; here it is tried first, so a person can overrule a wrong match.
- **The barcode rule has nothing to work on.** It is ported and tested, but the suite's stock items carry no barcode, so nothing is matched by it. Pair those by hand.
- **Stock comes from the last read of the shop**, not a live read, and is the shop's whole count rather than "available" at one location. For watching that is fine. Before anything is sent, the stock job needs a live read of "available" at the location that ships (TuftStock's rule), or it could oversell.
- **Compared with what Michaels shows now**, not with what was last sent (nothing has been sent).
- **Hourly, not every ten minutes.**
- **Heads-ups go to Messages**, not email.
- Not ported yet, because they belong to later stages: the listing builder, colours, part refunds, returns, cancellations, tracking, order creation.

## 2. What the owner does to connect

1. Sign in to the **Michaels Developer Account Center** (from the Michaels seller site: michaels.com/developer-api) and make an **API key**. For this stage give it **Read Only** on Listing, Inventory, Price and Order. Make a new key for the suite rather than sharing TuftStock's: keys are easy to make, and a separate one can be thrown away without touching TuftStock. Production keys need a request and Michaels' approval; sandbox keys don't.
2. Note **the day the key was made**.
3. In the suite: **Connections → Michaels Marketplace**. Paste the key, type the day, choose "The real marketplace" (or the sandbox), and press Connect. The key is never shown again.
4. **Settings → Stock → Michaels**: tick "Look at Michaels", leave units held back at 1 (or set your own), and save.
5. Wait a few minutes, or press **Look now** on the Overview.
6. **Listings → Needs a look**: pair anything unmatched by typing its SKU in your shop.

To put in a new key later: make it, then under Connections disconnect Michaels Marketplace and connect again with the new key. Pairings and history are kept.

## 3. The stages still to build

Each needs wider permissions, from Michaels and from the shop. Workspaces that don't connect Michaels must never be asked for any of them.

| Stage                    | What it does                                                                                                              | Michaels key needs                 | Shop permissions it needs                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| Stock and prices out     | Sends the stock and price each look works out, only what changed, with a regular re-send                                  | Full Access on Inventory and Price | None new to write. A live read of "available" at the shipping location (stock and locations, read) |
| Orders in, tracking back | Creates each Michaels order in the shop as a paid order, once; confirms it on Michaels; sends tracking back when it ships | Full Access on Order               | **Create orders** (and a customer record for the buyer's name); read fulfilments                   |
| Cancellations            | Copies a cancellation each way; awkward cases are flagged for a person                                                    | Full Access on Order               | **Cancel orders**, with restock                                                                    |
| Returns and refunds      | Lists returns to approve or reject; records Michaels' refund on the shop order; puts returned stock back unless unticked  | Full Access on Returns             | **Refund with restock** (no money moves: Michaels refunded the buyer)                              |
| Publishing               | Lists a shop product on Michaels as a draft                                                                               | Full Access on Listing             | None new (products, read)                                                                          |

Two of these change a rule of the suite and need saying out loud when they're built: creating, cancelling and refunding shop orders is far wider than "add a delivery" and "mark as sent"; and a cancellation or return would be the one place stock is put back in the shop automatically, which today only a checked-in delivery does. In TuftStock that sits behind its own "Restock automatically" switch.

Also to settle before sending: how shop orders are marked so one is never made twice (TuftStock finds an order by its source identifier, a note and a tag, which also catches orders another connector made); whose brand name a listing goes under; and the price rule (TuftStock lists at exactly the shop's price).

## 4. Cut-over runbook

Adapted from TuftStock's. The steps marked _later_ need stages that don't exist yet.

### Now: watch alongside whatever runs Michaels today

1. Connect with a Read Only key and switch on, as in section 2. The suite reads only, so it can run beside TuftStock (or any other connector) without getting in its way.
2. Leave it for a few days and check:
   - **Listings:** unmatched should be near zero, and must be under a tenth. Pair the rest by hand. TuftStock's hand-typed pairings do not come across by themselves: type them again on the Listings tab.
   - **Would send:** while TuftStock is live and keeping Michaels in step, this list should be nearly empty. Every row on it is a place the suite would do something different from TuftStock. Expect a few from timing (the suite compares against the last read of the shop). A pattern (always one too many, a whole product family) is a difference in the rule and must be understood before the suite ever sends.
   - **Orders:** every open order should say "Would become a shop order". One that says "couldn't be brought in yet" has a SKU to pair.
3. Replace the key before day 60. The suite reminds you.

### Later: handing over from TuftStock without both writing at once

The rule: **for each job, exactly one system may write, and the other is switched off for that job first.** TuftStock has a switch per job and a shadow mode; the suite will have the same. Do it in one sitting, one job at a time, in this order.

1. Make sure the suite has watched for several days with a near-empty Would send list and no unmatched orders.
2. Give the suite's Michaels key Full Access for the job being moved (or make a new key with it and reconnect), and grant the shop permissions that job needs.
3. **Stock and prices.** In TuftStock, untick "Send stock to Michaels" and "Send prices to Michaels" and wait for its current run to finish (its page shows the last run). Only then switch the suite's stock and price sending on, with the cut-over time set to now. Press "Look now" and check a few numbers on Michaels.
4. **Orders and tracking.** In TuftStock, untick "Import Michaels orders into Shopify" and "Send tracking to Michaels", and wait for its run to finish. Then switch the suite's on. The suite must only create orders placed after its cut-over time, and must look in the shop for an order's marks before creating it, so an order TuftStock already made is linked, not made again. Tracking is sent only for parcels shipped after the cut-over; TuftStock already sent the earlier ones.
5. **Cancellations and returns**, the same way, last.
6. Leave TuftStock's connector in **shadow mode** (not off) for a week. Its "what shadow mode would send" list then does for the suite what the suite's Would send list did for it. When it stays empty, switch TuftStock's connector off.
7. If anything looks wrong at any step: switch the suite's job off, then switch TuftStock's back on. Never the other way round.

Never copy the Michaels key from TuftStock through a file, a message or this repository. Its owner types it into Connections.

## 5. Not checked against the real Michaels

The suite's connector was tested against a made-up Michaels only. From TuftStock's code and notes, these are believed but unproven here:

- That `/listing/all-listings` carries each SKU's stock (`inventory`) and `price`, for single listings and for `subSkus`. If it doesn't, the look falls back to the two per-listing reads, 25 listings a look, so a big catalog takes several hours to fill in and Would send shows "Not read" until then.
- `GET /listing/inventory/{primarySkuNumber}` and `GET /listing/price/{primarySkuNumber}` are in Michaels' reference as TuftStock recorded it, but TuftStock itself never calls them. Their reply shapes (`skuInventories[].availableQuantity`, `skuPrices[].price`) are from the reference only.
- Whether a Read Only key is accepted for every read used here.
- `/order/query`: the name of the list inside the reply and whether pages start at 0 or 1. Handled either way, as in TuftStock, and a reply that can't be read as orders fails the look loudly.
- Rate limits are undocumented. The pace is TuftStock's (four calls a second at most, one at a time).
- Sandbox keys and the `/uat` address.

## 6. Trying it on staging

1. Apply the migration `supabase/migrations/20270102000100_michaels.sql` to the staging database (it also adds `michaels` to the providers a connection may have).
2. Deploy `web` and `worker` from this branch. No new environment variables, dependencies or services.
3. Use a workspace whose plan includes Stock and whose shop is connected and synced, so there are stock items to match.
4. Follow section 2 with a sandbox key if you have one, otherwise a Read Only production key.
5. Watch the worker's log for `michaels look … : done`, then open Stock → Michaels.
