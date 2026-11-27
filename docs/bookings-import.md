# Bringing bookings in from your earlier booking app

Settings → Bookings → **Bring your bookings across** takes three CSV files, your workshops, their dates and who has booked, and brings them into Bookings. It is for owners and admins.

This page says exactly what each file needs, and gives the one query that makes each file from the earlier booking app's database.

## How an import works

1. Pick what is in the file, then the file. It is read in your browser and sent as text; the file itself is never kept.
2. You are shown what it would do: how many are new, how many would be brought up to date, how many are already as the file says, and every row that was left out, by line number, with the reason. Nothing has been saved yet. (The database works the numbers out by doing the whole import and undoing it, so they are exact.)
3. Press **Bring these in**. If your records changed between looking and pressing, nothing is saved and you are shown the new picture instead.

Things that hold for every file:

- **Nobody is emailed or texted.** Bringing bookings in never sends a confirmation. Reminders and thank-yous your earlier app already sent, by email or by text, are noted, so they aren't sent again, and no thank-you (email or text) is ever sent for a class that had already happened when it was brought in. Where the file doesn't say whether a text went, a message whose email went counts as gone for the text too. A reminder that hadn't gone yet for a class still to come goes out as usual, at your reminder time (Settings → Bookings).
- **Twice is the same as once.** A second press of the button does nothing, and bringing the same file in again later changes nothing.
- **A bad row never stops a good one.** Rows that can't be used are left out and listed. Fix them in the file and bring it in again; the rows already in aren't added twice.
- **A paid booking is never turned away.** A booking that takes a date (or a shared room) over its limit is brought in all the same and marked "Over the limit", so you can sort it out. The date's page offers one press to raise the limit to fit.
- **Limits.** A file can be 4 MB and 10,000 rows at most. Split a bigger one and bring the parts in one at a time.
- **Format.** CSV with the column names on the first line. Capitals and spaces in column names don't matter, the order of columns doesn't matter, and columns that aren't listed here are ignored. Commas, semicolons or tabs between cells all work. Yes/no cells take `yes`, `no`, `true`, `false`, `t`, `f`, `1`, `0`.
- **Times.** `2027-03-06 15:00:00+00` and `2027-03-06T15:00:00Z` (with a time zone, as a database writes them) are read exactly. A time with no zone, like `2027-03-06 10:00` or `3/6/2027 10:00 am`, is read on your workspace's own clock. Dates like "booked on" may be a plain day (`2027-03-06`).

**Bring the files in this order.** Dates point at workshops, and bookings at dates.

| #   | File      | Why this place in the order                                                         |
| --- | --------- | ----------------------------------------------------------------------------------- |
| 0   | Your shop | Connect your shop first if your workshops are sold there, so new orders can follow. |
| 1   | Workshops | Each date names its workshop.                                                       |
| 2   | Dates     | Keeps each date's id, which carts and orders in your shop already carry.            |
| 3   | Bookings  | Each booking names its date.                                                        |

## 1. Workshops

| Column               | Needed | What goes in it                                                                                        |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `id`                 |        | The workshop's id in the earlier app. Dates point at it with `workshop_id`.                            |
| `name`               | yes    | The workshop's name. `title` works too.                                                                |
| `description`        |        | What people will make.                                                                                 |
| `duration_minutes`   |        | How long it runs, 5 to 1440. Empty leaves it (120 for a new one).                                      |
| `capacity`           |        | The usual places on a date, 1 to 500. `default_capacity` works too. Empty leaves it (8 for a new one). |
| `price`              |        | Price per place, for booking on your own pages. Leave it out for workshops your shop sells.            |
| `location`           |        | Where it happens. Shown as people pick a date, on your booking pages and in their emails.              |
| `shopify_product_id` |        | The shop product that sells it: the number, or the shop's long `gid://shopify/Product/…` form.         |
| `shopify_variant_id` |        | The variant the date picker puts in the cart.                                                          |
| `active`             |        | `no` for a workshop you no longer run: it is kept but hidden from your booking page.                   |

Matched by `id` (once brought in), else by shop product, else by name (capitals don't matter). A column that isn't in the file is left alone.

From the earlier app:

```sql
select w.id,
       w.title as name,
       w.description,
       w.duration_minutes,
       w.default_capacity as capacity,
       w.location,
       w.shopify_product_id,
       w.shopify_variant_id,
       w.active
from workshops w
order by w.title;
```

## 2. Dates

| Column            | Needed       | What goes in it                                                                                                   |
| ----------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `id`              |              | The date's id in the earlier app: the "Session ID" in carts and on orders. Kept as this date's id (see below).    |
| `workshop_id`     | one of these | The workshop's `id` from the workshops file.                                                                      |
| `workshop`        | one of these | The workshop's name, when there's no `workshop_id`.                                                               |
| `starts_at`       | yes          | Day and time it starts.                                                                                           |
| `ends_at`         |              | When it ends. Empty means the workshop's length.                                                                  |
| `capacity`        |              | Places on this date, 1 to 500. Empty means the workshop's usual places.                                           |
| `status`          |              | `scheduled`, `full`, `completed` or `cancelled`. Only `cancelled` changes anything: the date is marked cancelled. |
| `bookings_closed` |              | `yes` when the date had stopped taking bookings online.                                                           |
| `private`         |              | `yes` for a private class: never shown to shoppers, still bookable by you and by an invoice carrying its id.      |
| `notes`           |              | A note for the team.                                                                                              |
| `shared_group`    |              | The same word or id on dates that share one room's places. `capacity_group_id` works too.                         |
| `shared_capacity` |              | Places that room holds between them. Needed with `shared_group`.                                                  |

**A date keeps its id.** When `id` is the long kind of id (like `1b2c…-…`), the date keeps it here, so a cart someone filled before the switch, or an unpaid invoice that carries it, still lands on the right date. The id must not be in use already; if it is, the date is left out with "This date's id can't be used here", and nothing more is said about it. If a date at the same time for the same workshop is already here under its own id, the import uses that one and says how many were matched that way: carts carrying the old id will then show under Bookings → Needs a date, where you can put them on the date by hand.

Matched by that id, else by the earlier app's `id`, else by workshop and start. Dates with the same `shared_group` are tied into one shared room, but only if they run at the same time and none of them shares a room already.

From the earlier app:

```sql
select s.id,
       s.workshop_id,
       s.starts_at,
       s.capacity,
       s.status,
       s.bookings_closed,
       s.private,
       s.notes,
       s.capacity_group_id as shared_group,
       g.capacity          as shared_capacity
from sessions s
left join capacity_groups g on g.id = s.capacity_group_id
order by s.starts_at;
```

The earlier app keeps no end time (it uses the workshop's length), and its running seat count (`seats_booked`) isn't brought across: here seats are always added up from the bookings.

## 3. Bookings

| Column                  | Needed | What goes in it                                                                                                                                             |
| ----------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    |        | The booking's id in the earlier app, so bringing the file in again finds it.                                                                                |
| `session_id`            | yes    | The date's `id`, as in the dates file.                                                                                                                      |
| `customer_name`         |        | Their name. A booking needs a name or an email.                                                                                                             |
| `customer_email`        |        | Their email, for reminders. A booking with none is brought in but gets no emails.                                                                           |
| `customer_phone`        |        | Their phone number. Shown on the roster, and where text reminders go once you switch them on.                                                               |
| `sms_opt_in`            |        | `yes` if they agreed to text messages. Only they are ever texted.                                                                                           |
| `seats`                 | yes    | Places booked, 1 to 50.                                                                                                                                     |
| `status`                |        | `confirmed`, `attended`, `no_show` or `cancelled`. Empty means confirmed. Attended and no-show are kept as check-ins.                                       |
| `source`                |        | `shopify`, `manual` or `eventbrite`. A booking with a shop order counts as a shop booking; Eventbrite ones come in as added by you, tagged `eventbrite`.    |
| `shopify_order_id`      |        | The shop order's id. Kept, so a refund or cancellation in your shop still follows the booking, and a later order sync finds it instead of booking it again. |
| `shopify_order_number`  |        | The order number people see, like `#1042`.                                                                                                                  |
| `notes`                 |        | Your note on the booking.                                                                                                                                   |
| `tags`                  |        | Tags, with `;` between them. A database's `{gift,vip}` works too.                                                                                           |
| `email_opt_in`          |        | `no` if this booking's emails were switched off.                                                                                                            |
| `created_at`            |        | When they booked.                                                                                                                                           |
| `cancelled_at`          |        | When it was cancelled.                                                                                                                                      |
| `reminder_sent_at`      |        | When the reminder went. Filled in, it isn't sent again here.                                                                                                |
| `day_of_sent_at`        |        | When the day-of reminder went.                                                                                                                              |
| `followup_sent_at`      |        | When the thank-you went.                                                                                                                                    |
| `reminder_text_sent_at` |        | When the reminder went as a text. Empty: counts as gone if `reminder_sent_at` is filled in.                                                                 |
| `day_of_text_sent_at`   |        | When the day-of reminder went as a text. Empty: counts as gone if `day_of_sent_at` is filled in.                                                            |
| `followup_text_sent_at` |        | When the thank-you went as a text. Empty: counts as gone if `followup_sent_at` is filled in, or the class is already over.                                  |
| `amount_paid`           |        | What they paid, if you know. The earlier app doesn't keep it; leave it out.                                                                                 |

Matched by `id` once brought in, else by shop order and date. If your shop's order sync has already made a booking for the same order and date, that booking is matched, not doubled: the shop's own figures (places, cancelled or not) stand, and only what the sync can't know is added (the earlier id, a phone number, which emails and texts already went). A booking brought in before follows the file when it is brought in again. A booking can't change date through the import; move it from the date's page.

Every booking brought in gets a fresh private link of its own; nobody has it until you press "Send the confirmation again" on the roster.

From the earlier app. An email column counts a message as gone when the earlier app sent it by email or text, or decided not to and marked it "skipped"; the three text columns look at its texts alone (`channel = 'sms'`), so a text that never went can still go from here once you switch texts on:

```sql
select b.id,
       b.session_id,
       b.customer_name,
       b.customer_email,
       b.customer_phone,
       b.sms_opt_in,
       b.seats,
       b.status,
       b.source,
       b.shopify_order_id,
       b.shopify_order_number,
       b.notes,
       array_to_string(b.tags, ';') as tags,
       b.email_opt_in,
       b.created_at,
       b.cancelled_at,
       (select min(l.sent_at) from notification_log l
        where l.booking_id = b.id and l.template_key = 'reminder_48h'
          and l.status in ('sent', 'skipped')) as reminder_sent_at,
       (select min(l.sent_at) from notification_log l
        where l.booking_id = b.id and l.template_key = 'reminder_2h'
          and l.status in ('sent', 'skipped')) as day_of_sent_at,
       (select min(l.sent_at) from notification_log l
        where l.booking_id = b.id and l.template_key = 'followup_24h'
          and l.status in ('sent', 'skipped')) as followup_sent_at,
       (select min(l.sent_at) from notification_log l
        where l.booking_id = b.id and l.template_key = 'reminder_48h' and l.channel = 'sms'
          and l.status in ('sent', 'skipped')) as reminder_text_sent_at,
       (select min(l.sent_at) from notification_log l
        where l.booking_id = b.id and l.template_key = 'reminder_2h' and l.channel = 'sms'
          and l.status in ('sent', 'skipped')) as day_of_text_sent_at,
       (select min(l.sent_at) from notification_log l
        where l.booking_id = b.id and l.template_key = 'followup_24h' and l.channel = 'sms'
          and l.status in ('sent', 'skipped')) as followup_text_sent_at
from bookings b
order by b.created_at;
```

## 4. Message wording

Optional. Your earlier app's own words for each email and text, so you don't have to type them again. It goes under Settings → Bookings → Bring your bookings across, in the "Message wording" box, and you see every message, translated, before anything is saved. It only fills in words: no text is switched on, and nothing is sent.

| Column  | What goes in it                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------ |
| key     | The earlier app's message: confirmation, reminder_48h, reminder_2h, followup_24h, booking_cancelled, booking_rescheduled |
| channel | email or text (sms reads as text)                                                                                        |
| subject | The email's subject; left empty for a text                                                                               |
| body    | The words, with the earlier app's fill-ins                                                                               |

Where each goes: confirmation → "You're booked"; reminder_48h → the reminder; reminder_2h → the day-of reminder; followup_24h → the thank-you; booking_cancelled → both "Booking cancelled" and "Cancelled by a shop refund" (the earlier app had one notice for both); booking_rescheduled → "Moved to another date". The note to you about a new booking (owner_new_booking) stays behind: that one uses our words here.

Fill-ins are changed to ours: `{{first_name}}` stays, `{{full_name}}` → `{{name}}`, `{{workshop_title}}` → `{{workshop}}`, `{{session_date}}` → `{{date}}`, `{{session_time}}` → `{{time}}`, `{{location}}` → `{{place}}`, `{{seats}} seat(s)` (or `{{seats}}`) → `{{places}}` ("2 places"). `{{manage_link}}` is kept only in the confirmation email, where it becomes the customer's own link to change or cancel; elsewhere it was a contact link, which has no match here, so it is taken out and the preview says so. An email written with markup is turned into plain text.

The query (it only reads):

```sql
select t.key, c.channel, coalesce(t.subject, '') as subject,
       case when c.channel = 'email' then t.body_email else t.body_sms end as body
from notification_templates t
cross join (values ('email'), ('text')) as c (channel)
where (c.channel = 'email' and coalesce(t.body_email, '') <> '')
   or (c.channel = 'text' and coalesce(t.body_sms, '') <> '')
order by t.key, c.channel;
```

## Running the queries

The queries only read. Run them against the earlier app's database, either way:

- **Supabase's SQL editor**: paste a query, run it, and use _Export → Download CSV_.
- **psql**, with the database's direct address: `\copy ( <query without the final semicolon> ) to 'dates.csv' with (format csv, header)`

Its times are stored with their time zone, so they come out exact (for example `2027-03-06 15:00:00+00`).

## The evening of the switch

1. Stop adding dates in the earlier app.
2. Run the three queries and bring the files in: workshops, then dates, then bookings. Look at each before pressing.
3. Open three dates that are coming up and check them by eye against the earlier app's rosters.
4. Point the shop's order messages at the suite and swap the date picker snippet (Settings → Bookings → Shop product page).
5. Place one test order and refund it.

Bringing a file in again later (say the next morning, for bookings made in between) is safe: what is already here is matched, and only what's new or changed is brought in.
