# Switching Bookings over

Read [the shared list](README.md) first: what has to be true of the live site before any tool moves.

Bookings is the switch with the most customer messages in it: confirmations, reminders, day-of reminders, thank-yous, cancellation notices and texts, from both apps, plus Eventbrite and a change to your shop's theme. Read the whole list before the day, and the last section first: **one problem should be fixed before you switch.**

## Before the day

**Connections**

- **Your shop** (Connections → Shopify). Watch only is enough to turn shop orders into bookings. Tagging orders that need you also needs the shop's permission to change orders (Settings → Bookings → Order tags). **If you'll ever connect the shop again, for any reason, do it before the import** (see the last section).
- **Twilio** (optional, for texts): your same Twilio account (Connections → Twilio; [text-reminders.md](../text-reminders.md)).
- **Eventbrite** (optional): your private token (Connections → Eventbrite; [eventbrite.md](../eventbrite.md)).
- **Stripe** only if some workshops are booked and paid for on the suite's own booking page rather than in your shop.

**Files to bring across** at **Settings → Bookings → Bring your bookings across**, made with the read-only queries in [bookings-import.md](../bookings-import.md): workshops, then dates, then bookings, and optionally the fourth, your earlier app's message wording. Do a trial run of the queries before the day so the evening itself is quick: look at each preview, but don't press **Bring these in** until the day. Before the day, also settle the cases [the side by side](../bookings-side-by-side.md) (section 5, "Things to settle before the switch") lists: coming dates whose seat count has no bookings behind it, bookings with no email, more than 50 places on one booking.

**Settings to copy across by hand, before the import** (so the first reminders go at the right time, in your words):

| From your earlier booking app               | Here                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Reminder lead time                          | Settings → Bookings → Emails & questions → "Send a reminder". **Your earlier app used 48 hours; the suite starts at 24.** |
| Day-of reminder, thank-you and its delay    | The same screen (both start switched off)                                                                                 |
| Cancellation notice after a shop refund     | The same screen (starts switched on)                                                                                      |
| Message words and subjects                  | Settings → Bookings → Email words, or the fourth file on the import screen, which fills them in for you to check          |
| Where customers' replies go                 | Settings → Bookings → Email words (the reply-to)                                                                          |
| Booking cut-off, workshop tag, contact link | Settings → Bookings → Shop product page                                                                                   |
| Shared rooms                                | Come in with the dates file                                                                                               |
| Owner's daily email                         | Settings → Bookings → Daily email                                                                                         |
| Teaching rates; supplies and vendors        | Settings → Bookings → Budget; Bookings → Classroom (typed in, there's no file)                                            |
| Text wording and which texts go             | Settings → Bookings → Text reminders. **Leave texts switched off** until "On the day", step 13.                           |

Then finish **Bookings → Set up**. Its "Paste the date picker into your shop's theme" item closes once any booking from a shop order is here, so after the import it isn't proof the new picker is in your theme: step 9's test order is.

## What will be different

- **No Google Calendar.** Dates aren't kept on the studio's shared calendar. Your earlier app's calendar stops showing anything new once it stops getting changes.
- **"Upcoming classes" is a list, not a month calendar,** with no filter by workshop; each date's button opens its product page.
- **The emails come from the suite's own sending address**; replies go where you set the reply-to.
- **Bookings → Messages sent lists what goes out by itself.** Confirmations and emails you send with a press go at once and aren't listed there.
- **The shop checkout's "text me offers" tick isn't taken as consent** for booking texts. Only the picker's own tick counts.
- **No "copy the date's id" helper** for a private class billed by a shop invoice.
- **No "dates that need promotion", no recent bookings feed** on the Bookings home screen, and no workshop sales total for a period (Money may supply that later).
- **Eventbrite bookings brought across keep no Eventbrite order number**, so a later refund of one of those is told to the team in Messages rather than followed.
- **Text reminders**: no delivery reports from Twilio; no texts when you cancel or move a date or a person yourself (those go by email).
- **Your team hub page's booking cards** stop updating once the earlier app is off.

## On the day, in order

Pick a quiet evening. Steps 2 to 8 belong in one sitting, as close together as you can make them.

1. **Your earlier booking app: stop adding or changing dates.** Tell the team.
2. **Your earlier app: switch every message off.** On its Templates page set each message, email and text, to Disabled. From now it sends nothing to anyone, but it keeps writing down shop orders, which is useful if you need to go back. A reminder due in the next few minutes simply waits: the suite sends it after the import, because a disabled message isn't marked as sent. **To confirm:** after this step, its message log shows nothing new. While it keeps listening it may still tag orders in your shop by its own seat counts (it has the permission to), which stop matching once bookings are made here; treat its tags as out of date. When you're settled (a week or two), have its shop webhooks removed for good.
3. **If you use Eventbrite, stop your earlier app's five-minute push to Eventbrite**, so the two don't both change ticket numbers. In its Supabase SQL editor: `select cron.unschedule('eventbrite-sync-5m');`. Leave its Eventbrite webhook for now (step 11).
4. **Run the three queries** and bring the files in: workshops, then dates, then **straight away** bookings. Read each preview before pressing. Between the dates file and the bookings file, the suite books any shop order it hears about for those dates and sends its own confirmation; so keep the gap to minutes, and don't fulfil, edit or refund workshop orders in your shop meanwhile.
5. **Open three coming dates** and check them against your earlier app's rosters by eye.
6. **Bookings → Needs a date.** Orders placed between step 2 and the dates file land here. They are usually on the roster already from the bookings file: check the roster before putting anyone on a date, or they'd be booked twice (the suite refuses the same date twice, but not a different one).
7. **Send the confirmations nobody sent.** Anyone who booked between step 2 and the bookings file got no confirmation from either app. Find them (Bookings → All bookings, booked since step 2) and press "Send the confirmation again" on their roster.
8. **Swap the date picker in your shop's theme.** Take out your earlier app's snippet and paste the two from Settings → Bookings → Shop product page (the page snippet, and the cart guard in the theme layout). Try it on a copy of your theme first and preview it, then publish. Until this is done, shoppers see your earlier app's picker, with its seat counts, which no longer change.
9. **Place one test order** for a coming date, then refund it. Right: one booking on the roster, one confirmation email (from the suite), the place given back after the refund, and one cancellation notice.
10. **If you use Eventbrite**, in the suite: Settings → Bookings → Eventbrite → "Switch on order updates", tick the workshops sold there, and on Bookings → Eventbrite link each coming date to its event.
11. **Then, straight away,** delete your earlier app's webhook on Eventbrite. Done in this order, an Eventbrite order is always heard by at least one app: one arriving before step 10 is booked silently in your earlier app and comes across when you bring the bookings file in again (step 14). One arriving between steps 10 and 11 is booked in both.
12. **Your earlier app's daily email to you**, if you've switched the suite's on: `select cron.unschedule('owner-digest-daily');` in the same SQL editor.
13. **Texts.** The import doesn't note which texts your earlier app already sent, so switching texts on straight away would text some people twice. Choose one:
    - **No doubles:** switch "Send text reminders" on 48 hours after the switch (your reminder text's lead time). Classes in the first 48 hours get only the reminder your earlier app already sent; classes in the two days after that get theirs as soon as texts go on, later than usual. Leave the thank-you text off for 15 days.
    - **No gaps:** switch texts on now; people with a class in the next 48 hours get a second reminder text.

    Either way, at the moment you switch texts on, point Twilio's "A message comes in" webhook at the suite's address (shown on Settings → Bookings → Text reminders), so STOP replies are heard here. A fix to carry the earlier app's sent texts across has been suggested as a separate task; with it, this step is simply "switch texts on".

14. **The next morning, bring the bookings file in again.** Only what's new is added; anything the suite already booked from a shop order is matched, never doubled. **Eventbrite bookings are the exception:** they come across without their Eventbrite order number, so one the suite booked itself after step 10 would be added a second time. In the preview, look at any new booking from Eventbrite and take its row out of the file if it's already on the roster.

## Check it worked

**First hour**

- The test order was booked once, confirmed once, and freed by its refund.
- Bookings → Coming up: the next few dates show the same number of people as your earlier app's rosters.
- The product page shows the new picker, with "ET" on the times; adding a date to the cart puts it on the cart line.

**First day**

- Bookings → Messages sent: tomorrow's reminders went once, and only to people your earlier app hadn't already reminded.
- Messages: any "paid without a date" heads-up is accounted for.
- If you use Eventbrite: each linked date shows "On Eventbrite" on its page, and the ticket numbers there match the places left here.

## If something goes wrong

1. Put your earlier app's snippet back in the theme (your theme's earlier version is in Shopify's theme history).
2. Switch your earlier app's messages back on (Templates).
3. **Stop the suite's emails for the bookings you're taking back.** There is no switch for a whole workspace: on each coming date's roster, untick "Send them reminders and updates" for each person, or they'd get reminders from both apps.
4. Anything booked, moved or cancelled by hand in the suite since the switch has to be done in your earlier app too. Shop orders were written down by your earlier app all along (step 2 left it listening).
5. Eventbrite: its links are still in your earlier app. Press "Register webhook" on its Eventbrite page, and ask your developer to start its five-minute push again. In the suite, untick the workshops at Settings → Bookings → Eventbrite so it stops pushing. **To confirm:** that unticking stops the pushes for dates already linked.
6. Texts: point Twilio's webhook back at your earlier app.

What can't be undone: emails and texts that went, a confirmation link sent (sending it again makes a new one and stops the old), and tags added to orders in your shop.

## Still needs a decision or isn't ready

- **Fix first: a moved shop booking gets booked again.** When a shop booking has been moved to another date (in your earlier app before the switch, or in the suite after), the next time your shop mentions that order (it's fulfilled, edited, refunded in part, or the shop is read in full), the suite books it again on the date the cart named and emails a new confirmation. It applies to every imported booking your earlier app had moved. A fix has been suggested as a separate task. Until it's in, don't switch, or check every moved booking's original date after any change to its order.
- **Connecting your shop again after the import** reads its whole order history. Any order for a date that's here but has no matching booking (moved, deleted in your earlier app, or a past class whose seats had no bookings behind them) would be booked and emailed a confirmation, even for a class long over. Do any reconnecting (for Order tags, Stock or Shipping permissions) before the import, and make sure the live site's first full read of the shop has finished before the dates file goes in. The same suggested fix covers this.
- **The live site update** ([the shared list](README.md), item 1): every part of this list, from the imports to the new picker, needs it. Needs your go-ahead.
- **Order tags in your shop** need the shop's permission to change orders, which watch only rules out.
- **Google Calendar** isn't built.
- **To confirm:** on the live site, that Postmark sends from `EMAIL_FROM` and that the reply-to you set reaches your inbox ("Send me a test" on Settings → Bookings → Email words).
