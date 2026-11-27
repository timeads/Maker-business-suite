# Switching Stock over

Read [the shared list](README.md) first: what has to be true of the live site before any tool moves.

This moves reordering, suppliers, purchase orders, checking deliveries in and supplier balances. **Michaels stays in your earlier stock app**, which keeps running for that alone: the suite only watches Michaels for now.

## Before the day

**Connections**

- **Your shop** (Connections → Shopify). Stock reads its items, counts and sales. While the shop is watch only, checking a delivery in here doesn't change the shop's count (see the last section).
- **QuickBooks** (optional, read only): to read payments to suppliers into Balances. Switch it on at Settings → Stock → Planning → "Read payments to my suppliers from QuickBooks".
- **Gmail** (optional): to email orders to suppliers from your own address. It asks only to send email. Offered only once the live site has its Google keys ([gmail-orders.md](../gmail-orders.md)); the starting words are at Settings → Stock → Order emails.
- **UPS** (optional): live status for UPS tracking numbers on incoming orders, only with your own UPS account connected for real, not a practice one. It is the same connection Shipping buys labels with.
- **Michaels** (optional, watch only): a **new Read Only key**, never your earlier app's ([michaels-connector.md](../michaels-connector.md), section 2). Then Settings → Stock → Michaels.

**Files to bring across.** Let the shop's first read finish first (Settings → Stock → "Reads of your shop"): it makes a supplier from each vendor name on your products, so your files should use the same supplier names. Download each file from your earlier stock app's Settings → **Move your data** (or use the queries in [stock-import.md](../stock-import.md)), then bring it in at **Settings → Stock → Bring your records across**, in this order, reading each preview before pressing **Bring these in**:

1. Suppliers
2. Item planning (supplier, cover days, spare, case size, smallest order, own cost, "don't reorder", "hidden")
3. Purchase orders (open and finished)
4. Past deliveries
5. Supplier ledger (entries flagged for a second look come across as "to check")
6. Past daily counts (the sold-out days, so sales rates aren't pulled down)

Bringing a file in twice changes nothing, and nothing brought in ever reaches your shop or raises a count.

**Settings to copy across by hand**

| From your earlier stock app                   | Here                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Default lead time, cover days, review buffer  | Settings → Stock → Planning: "Days to arrive", "Each order covers (days)", "I place orders every (days)"  |
| Seasonality on or off                         | Settings → Stock → Planning: "Plan ahead for busy seasons"                                                |
| Tags that mean "never reorder"                | Settings → Stock → Planning: "Never reorder anything with these tags in my shop" (and the name-words box) |
| Seasons and their lifts                       | Settings → Stock → Seasons                                                                                |
| Supplier closures                             | On each supplier (Stock → Suppliers)                                                                      |
| Saved views                                   | Saved again on Stock → Everything                                                                         |
| Order email wording                           | Settings → Stock → Order emails                                                                           |
| Business address and logo on order PDFs       | Settings → Shipping → Ship-from & boxes, and a picture tagged `logo` in Social → Assets                   |
| Who sends you bills by email                  | Settings → Stock → Balances & bills by email ([bills-by-email.md](../bills-by-email.md))                  |
| Tracking numbers on orders still on their way | Typed onto each open order (Stock → Orders); they don't come across in a file                             |
| Michaels pairings you typed by hand           | Stock → Michaels → Listings, typed again                                                                  |

Then finish **Stock → Set up**.

## What will be different

- **Tracking isn't read out of a supplier's reply emails.** Type tracking numbers onto the order by hand.
- **No FedEx status.** UPS only, and only with your own UPS account connected for real. Mark other parcels "It's here" yourself.
- **The bills calendar doesn't keep itself up to date.** Download the calendar file from Stock → Balances again when bills change; downloading again updates the same entries.
- **"Reads of your shop" shows each read's result, but not how many items it brought in.**
- **Reads are hourly**, not nightly; press "Read my shop now" on Stock → To order for a fresh one.
- **Emails your earlier app sent for each order don't come across.** Keep the earlier app readable for those.
- **Michaels can't be sent anything from here**: no stock or prices out, no orders in, no tracking back, no cancellations or returns, no publishing. Your earlier stock app keeps doing all of it.
- **While the shop is watch only, a delivery you check in here doesn't change the shop's count.** Add it in your shop by hand (see "On the day", step 5).

## On the day, in order

1. **Compare for a couple of weeks first.** Put Stock → To order beside your earlier app's reorder list. Differences you can't explain are worth asking about before you rely on the new one.
2. **Pick the day.** From that morning, the team uses only the suite for purchase orders, checking deliveries in and supplier balances. Tell everyone: the earlier app stays open for Michaels, and its order and delivery screens still work, so it is easy to use the wrong one.
3. **Bring the files in again that morning**, in the same order. Only what changed since the first time comes in.
4. **Purchase orders:** don't press "Email this order" here for an order your earlier app already sent; it would go to the supplier a second time. New orders are emailed from here only.
5. **Checking deliveries in, and your shop's count.** This is the one place the two apps could both change something in your shop, or neither:
   - **While the shop is watch only** (today): check each delivery in here, then add the same units in your shop by hand. The earlier app's "receive" must not be used for it as well, or the count goes up twice.
   - **Once the shop allows it** (with your go-ahead): tick Settings → Stock → Planning → "Add deliveries to my shop's count when I check them in", and stop adding by hand from the same moment. A delivery checked in here goes to the shop once; one the shop turned down can be offered again by an owner or admin only when the shop certainly added nothing.
6. **Bills by email:** if you forward bills to the bills address, stop entering the same ones into the earlier app.
7. **Leave Michaels exactly as it is** in the earlier app. If you connected Michaels here, it only watches.

## Check it worked

**First hour**

- Stock → Suppliers: lead times and smallest orders look right.
- Stock → Everything: the supplier column is filled in; "No supplier" holds only what you expect.
- Stock → Orders: the open orders are the ones you're waiting on, and "on order" in the list matches.
- Stock → Balances: each supplier's balance matches your earlier app's.

**First day**

- The first delivery checked in here: the order shows it arrived, and your shop's count went up by exactly that much (by your hand, or by the suite once allowed; never both).
- Messages: no heads-up you don't understand.

## If something goes wrong

Go back to your earlier stock app for orders and deliveries; it was never switched off. Anything you did here meanwhile has to be done there too (an order placed, a delivery checked in, a payment recorded), by hand.

What can't be undone: an order emailed to a supplier, and units added to your shop's count. If a count went up twice, correct it in your shop. Everything brought in from a file can be left; it never touched your shop.

## Still needs a decision or isn't ready

- **The live site update** ([the shared list](README.md), item 1). Every import, the safety checks and the Michaels watch need it. Needs your go-ahead.
- **Adding deliveries to the shop's count** needs the shop's permission to change stock, which watch only rules out. Until you decide, the count is updated by hand.
- **Emailing orders from Gmail** needs the Google keys on the live site, and Google's approval if anyone outside your own Google organisation will connect ([gmail-orders.md](../gmail-orders.md)).
- **Michaels sending** isn't built. Your earlier stock app stays on for it.
- **Two years of sales** need `read_all_orders` on the shop app; without it, rates are worked out from 60 days. **To confirm** on the live app.
- **To confirm:** an invoice brought in from the ledger file and then read again from a forwarded bill with the same invoice number corrects the one entry rather than adding a second. The reader keeps one row per invoice number, but this pairing with imported entries wasn't checked.
- **To confirm:** a payment brought in from the ledger file isn't added again when "Read payments to my suppliers from QuickBooks" is on. The reader skips payments already typed in; whether it treats imported ones the same wasn't checked.
