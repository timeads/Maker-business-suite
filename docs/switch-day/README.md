# Switch day

One list for each tool, for the day you stop using one of your earlier apps and start using the suite for that job:

- [Money](money.md)
- [Stock](stock.md)
- [Social](social.md)
- [Help desk](helpdesk.md)
- [Bookings](bookings.md)
- [Shipping](shipping.md)

Each list has the same six parts: what to get ready, what will be different, the day itself in order, how to check it worked, how to go back, and what still stands in the way. A line starting **To confirm** is something we couldn't check from here; look at it on the real screen before relying on it.

## The one rule for every switch

**Each job is done by exactly one system at a time.** For anything that reaches the outside world (an email or text to a customer, a post, a label, a change in your shop, a change on Eventbrite or Michaels) the lists say which system does it before, during and after the switch, and in what order to turn one off and the other on so that nothing is done twice and nothing is missed. Where the two can't be lined up exactly, the list says which way it errs and what to check.

## Before you switch any tool

None of these is something you do in the suite's own screens. Each one changes the live site, so **each needs your go-ahead before anyone does it**. Nothing here has been done yet.

1. **The live site is brought up to date.** The live database has had no changes since `20261223000100` (the shipping order plans). There are 86 changes after that one in `supabase/migrations`, and every tool's list leans on them: the imports, the help desk's inbox, the bookings emails, Social's accounts, Money's expenses and debts, Shipping's rules and shop steps. They go on in order, together with the matching web and worker code. The worker must be running: it sends every email and text, reads your shop and your books, and sends your posts.
   **To confirm:** which version of the code the live web and worker are running today.
2. **The site's own address is the real one.** `NEXT_PUBLIC_SITE_URL` is the live `https://` address. Your shop's order messages, the date picker snippet, Eventbrite's order updates, Twilio's STOP replies, Meta's messages and the help centre all point at it.
3. **Email can go out and come in.**
   - Out: `POSTMARK_SERVER_TOKEN` and `EMAIL_FROM` are set. Every booking email and every help desk reply goes through them; without them nothing is sent.
   - In: `INBOUND_EMAIL_DOMAIN` is a domain Postmark receives mail for and is also a verified sending domain there (help desk replies go out from it), `POSTMARK_INBOUND_SECRET` is set, and Postmark's inbound webhook points at the address in `.env.example`. The help desk and Stock's bills address both need this.
4. **The shop app's permissions are what you want.** Your live shop is connected **watch only**, by your choice. That holds back every write to the shop:

   | Tool     | What stays off while the shop is watch only                                 | Shop permission it needs                    |
   | -------- | --------------------------------------------------------------------------- | ------------------------------------------- |
   | Stock    | Adding a checked-in delivery to the shop's count                            | `write_inventory`, `read_locations`         |
   | Shipping | Marking an order sent (and the shop's email to the customer), pickups, undo | `write_merchant_managed_fulfillment_orders` |
   | Bookings | Tagging orders that need you ("oversold", "needs a date")                   | `write_orders`                              |

   Changing it means three things, each with your go-ahead: the shop app's released version lists those permissions ([shopify-permissions.md](../shopify-permissions.md)), you approve the update in your shop, and you connect the shop again from Connections choosing the option that isn't watch only. **Connecting the shop again starts a read of its whole order history**; on the Bookings list that matters (see there), so do it before the Bookings switch or not until that list's blocker is fixed.
   Also check whether the app has `read_all_orders`. Without it the shop hands over only the last 60 days of orders, so Stock's sales history and Money's figures start thin. **To confirm:** whether the live shop app has `read_all_orders`, and whether it is allowed to read delivery addresses (Shipping needs them).

5. **QuickBooks points at your real books.** `QUICKBOOKS_ENVIRONMENT=production` (the default is the practice "sandbox").
6. **The keys for what you'll use are set** (on both the web and worker services where `.env.example` says so). Each is optional; the matching screen simply isn't offered without it:

   | For                                               | Keys                                                                                         |
   | ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
   | Emailing purchase orders from your Gmail (Stock)  | `GOOGLE_MAIL_CLIENT_ID`, `GOOGLE_MAIL_CLIENT_SECRET` ([gmail-orders.md](../gmail-orders.md)) |
   | Facebook and Instagram (Social, Help desk)        | `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`                                |
   | TikTok, LinkedIn (Social)                         | see [tiktok-linkedin.md](../tiktok-linkedin.md)                                              |
   | Claude drafts, bills by email, the manual, Social | `ANTHROPIC_API_KEY` (web and worker)                                                         |
   | Card payments on the suite's own booking pages    | `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_CONNECT_WEBHOOK_SECRET`                                  |
   | Postage (EasyPost, UPS, Redo), Twilio, Eventbrite | none here: you paste your own keys on the Connections page                                   |

7. **Your workspace is ready.** Its plan includes the tool (and the extras you'll use: texts, Eventbrite, Michaels). Settings → Workspace has your time zone and currency. Settings → People has your team, each with the right role. Settings → Brand kit and Settings → Look are done.
8. **You have a copy of each earlier app's data** from before you start, kept somewhere safe. It is what makes going back simple.

## The order to switch in

| #   | Tool                     | Why here                                                                                                                                                                                                                      |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [Money](money.md)        | Lowest risk. It only reads your shop and your books and sends nothing to anyone, so it can run beside your earlier dashboard for as long as you like.                                                                         |
| 2   | [Stock](stock.md)        | Its one write to the outside world (adding a delivery to the shop's count) is off while the shop is watch only, so the switch is mostly bringing records across and comparing. Michaels stays in your earlier stock app.      |
| 3   | [Social](social.md)      | A clean cut is easy (one day, one place that posts), but there is no import, so the library and the plan are set up by hand first.                                                                                            |
| 4   | [Help desk](helpdesk.md) | Customer-facing, but nothing is lost if done in order: mail is forwarded here before your earlier help desk stops reading it. Your earlier help desk keeps running afterwards for shipping.                                   |
| 5   | [Bookings](bookings.md)  | The most customer emails and texts, a theme change in your shop, and one real double-booking risk to fix first. Easier once Money and the help desk are settled.                                                              |
| 6   | [Shipping](shipping.md)  | The most still missing (labels abroad, the shop being told a parcel went while it's watch only, two postage sources not yet tried for real). It lives inside your earlier help desk app, which stays on until this one moves. |

How the tools lean on each other:

- **Shipping and the help desk are one earlier app.** Moving the inbox first is fine; keep the earlier app running for packing until Shipping moves.
- **Michaels lives in your earlier stock app.** That app stays on for Michaels after Stock moves, until the suite can send to Michaels ([michaels-connector.md](../michaels-connector.md)).
- **Stock prints its purchase orders with Shipping's ship-from address.** Fill in Settings → Shipping → Ship-from & boxes before Stock's first order PDF, even though Shipping moves last.
- **Money counts workshops by line from Bookings** once you add a "Bookings workshop" rule. Before the Bookings switch, that rule finds no bookings; leave it for after.
- **The help desk shows "back in stock?" from Stock and parcels from Shipping.** Both just stay empty until those tools move.
- **Your team hub page's home cards** read from your earlier apps. The suite doesn't feed them, so each card stops updating when its earlier app is switched off.

## While you're switching

- Heads-ups from every tool land in **Messages**. Keep it open on the day.
- Each tool has a **Set up** row in its menu that lists what's left; it is the quickest check that nothing was skipped.
