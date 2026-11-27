# Switching Shipping over

Read [the shared list](README.md) first: what has to be true of the live site before any tool moves.

Shipping lives inside your earlier help desk app. After this switch that app has nothing left to do here; keep it open until its last labels are past the carrier's time limit for voiding.

The two things that matter on the day: **every parcel gets exactly one label**, and **every sent order is marked sent in your shop exactly once**, because that is what emails the customer their tracking number.

## Before the day

**Connections** (on the Connections page; each key is pasted by you and kept locked away):

- **Your shop.** Shipping reads orders and their delivery addresses from it. While it is watch only, the suite can't mark an order sent, tell the shop about pickups, or undo a sent order there (see the last section).
- **Where you buy postage**: EasyPost, your own UPS account and Redo, the same accounts your earlier app uses. Make sure each is connected with its live key, not a practice one (Shipping → Set up says so if one is buying practice labels).

**Settings to copy across by hand.** Your earlier app's rules and remembered packings don't come across; the suite starts remembering how you pack from your first labels here.

| From your earlier help desk's shipping               | Here                                                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Return address and phone                             | Settings → Shipping → Ship-from & boxes                                                                                                                                              |
| Boxes, envelopes, their empty weights, the usual box | Settings → Shipping → Ship-from & boxes                                                                                                                                              |
| Signature over an amount                             | Settings → Shipping → Ship-from & boxes ("Ask for a signature on orders of at least")                                                                                                |
| Rules (box, signature, service, hold)                | Settings → Shipping → Rules                                                                                                                                                          |
| Remember how I pack, on or off                       | Settings → Shipping → Rules                                                                                                                                                          |
| Packing slip layout, logo, message                   | Settings → Shipping → Packing slip                                                                                                                                                   |
| Which printer each computer uses                     | On **each** packing computer: Settings → Shipping → Printing on this computer → "Look for a Zebra on this computer"                                                                  |
| Mark sent in the shop and email the customer         | Settings → Shipping → Ship-from & boxes: "Mark the order as sent in my shop" and "…and have my shop email the customer their tracking number". Only offered once the shop allows it. |
| Tell the shop about pickups                          | The same screen: "Tell my shop about pickups"                                                                                                                                        |

Then finish **Shipping → Set up**, and buy one real label for a real order here, end to end, before the day (see "Check it worked").

**Do once in your earlier app before leaving it:** bring in Redo's shipping history there, if you use it for your shipping margin. The suite doesn't read Redo's history file.

## What will be different

- **No labels for orders going abroad, and no customs paperwork.** The suite says so on the order: buy that label elsewhere (your earlier app, while it's still on, or the carrier's own site) and record the parcel here by hand.
- **No blank labels** (postage with no order behind it, for a replacement or a sample) and no saving a label without an order to buy later. Buy those elsewhere and record them.
- **No list price beside your own price**, and so no savings figure; no "Fastest" mark.
- **Redo**: no balance warning, no checking whether Redo can take a signature, no comparing Redo with your own accounts.
- **"Test connection"** checks a key when it's pasted, not carrier by carrier.
- **Prices**: on the order page, any change of box, weight or address needs "Get rates" pressed again. A changed address isn't kept outside the order.
- **No warning before paying** for an address that wasn't found or a suggested fix not used.
- **If the shop refused "sent", there's no "try again" button**: mark it sent in your shop yourself. No invoice print from the order.
- **No "Ship" button from a help desk conversation**, and "Email customer" just opens your own email program, without starters.
- **No marketplace ship-by dates**: watch those yourself.
- **The queue doesn't refresh by itself on screen**; reload the page. Orders follow your shop within minutes.
- **Reports**: no average label cost, savings, loss-makers, share packed by scanner, weekly chart or table by service; 30 or 90 days only, with no comparison; no per-parcel profit.
- **Hold lengths**: tomorrow, next Monday, until released, or a day you pick.
- **Label batches** lists bulk runs only; void single labels from the Sent tab. Bulk buying follows each order's plan; you can't force cheapest or one service for a whole run. Up to 25 a run.
- **Tracking links** for OnTrac, DHL eCommerce and Amazon Shipping aren't there.
- **Keyboard**: K, J and Esc; no arrow keys, no Enter to open a row, no Ctrl+P on a pickup.
- **A slip sent straight to a Zebra** goes without product photos.

## On the day, in order

Switch at the end of a packing day, so the next morning starts clean.

1. **Finish the day's labels in your earlier app.** For every label it bought, check the order is marked sent in your shop (its "Labels for this order" can try again). An order your earlier app labelled but the shop still shows as unsent would turn up in the suite's queue the next morning and could get a second label.
2. **From the next morning, buy every label in the suite.** Tell the team; your earlier app's buying screen still works, so it's easy to use by habit.
3. **Marking orders sent in your shop:**
   - **While the shop is watch only** (today), the suite can't do it. After each label, mark the order fulfilled in your shop yourself, with the tracking number and the customer email ticked, or the customer hears nothing and the order sits in the queue.
   - **Once the shop allows it** (with your go-ahead), tick "Mark the order as sent in my shop" and "…and have my shop email the customer their tracking number", and stop marking by hand from that moment, or the customer could be emailed twice.
4. **Don't record here a parcel your earlier app already sent** ("record a parcel bought elsewhere"). With "Mark the order as sent in my shop" on, that would tell the shop a second time.
5. **Pickups:** mark each pickup ready and picked up in one app only. With "Tell my shop about pickups" on and allowed, the shop emails the customer to come and collect; a pickup already marked in your earlier app shouldn't be marked again here.
6. **Undoing a label** is done in the app that bought it. Keep your earlier app open until its last labels are past the carrier's time limit for voiding.
7. **Labels for orders abroad**: buy them in your earlier app while it's still on, and record the parcel here.

## Check it worked

**First hour (the first labels of the morning; do the same once with a test order to yourself before the day)**

- Each order bought here has one label at the price you expected, printed on that computer's printer, with its tracking on Shipping → Sent.
- In your shop, each of those orders is marked sent with that tracking number, once (by you, or by the suite once allowed).
- The customer's tracking email went once: your own test order shows it.

**First day**

- Shipping → To ship holds only orders still to send; nothing your earlier app already sent.
- Shipping → Sent: every parcel of the day is there, and each order is marked sent in your shop once.
- Each packing computer printed to its own printer.

## If something goes wrong

Buy labels in your earlier app again; it was never switched off. Orders sent here and marked sent in your shop leave its queue as they do here. A parcel bought here can be undone only here (Shipping → Sent), within the carrier's time limit.

What can't be undone: a label that's been paid for and used, a carrier's time limit for voiding, and a "sent" email the shop already sent the customer. A void here tells the shop to undo the sent order only when the shop allows it; otherwise undo it in your shop yourself.

## Still needs a decision or isn't ready

- **The live site update** ([the shared list](README.md), item 1). Rules, packing memory, bulk buying, shop steps, slips per box and more are in it. Needs your go-ahead.
- **Marking orders sent in your shop** needs the shop's permission to fulfil orders, which watch only rules out. Without it, every order is marked by hand. That is the main reason this tool goes last.
- **Labels abroad and customs** aren't built.
- **Your own UPS account and Redo** were built from your earlier app's request shapes and haven't been tried for real from the suite. Buy one real label from each, and void it, before relying on either.
- **Delivery addresses:** **to confirm** that the live shop app may read them; without them the queue has no addresses (Shipping → Set up says so).
- **Blank labels and labels saved without an order** aren't built.
