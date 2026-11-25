# Help desk: the owner's help desk app vs. the suite, side by side

Written 25 Nov 2026 before the rebuild, and brought up to date after it and again after the second pass. The old app was only read. Nothing here was checked against real mail or a real shop: see section 5.

**How to read the file references**

- **Old** paths are inside the owner's help desk repo (`public/js/…`, `src/…`).
- **New** paths are inside this repo: `desk/` means `src/app/w/[slug]/helpdesk/`, `lib/` means `src/lib/helpdesk/`, `mig/` means `supabase/migrations/`.
- **Matched** means the suite does it. **Partly** means some of it. **Missing** means it was looked for and not found.
- Size to close: **S** = a day or two, **M** = about a week, **L** = several weeks or a new integration.
- Shipping has its own file (`docs/shipping-side-by-side.md`) and is not counted here.

---

## 1. Summary

The old app has **126** help desk capabilities a person answering customers would notice.

- **Before the rebuild** (counted 25 Nov 2026): **18 matched**, **27 partly**, **81 missing**.
- **After the rebuild**: **76 matched**, **15 partly**, **35 missing**.
- **After the second pass** (files, Archive / Spam / Trash, bulk actions, undo send and the smaller items): **92 matched**, **11 partly**, **23 missing**.

| Area                           | Capabilities | Matched | Partly | Missing |
| ------------------------------ | -----------: | ------: | -----: | ------: |
| Menu, folders & views          |           20 |      15 |      2 |       3 |
| List column                    |           22 |      21 |      1 |       0 |
| Ticket header & actions        |           11 |       8 |      2 |       1 |
| Conversation                   |           10 |       7 |      0 |       3 |
| Composer                       |           21 |      17 |      1 |       3 |
| Details rail                   |           26 |      22 |      2 |       2 |
| Numbers                        |            2 |       0 |      1 |       1 |
| Settings & automation          |            7 |       2 |      1 |       4 |
| Channels                       |            3 |       0 |      1 |       2 |
| Repair manual & knowledge base |            4 |       0 |      0 |       4 |
| **Total**                      |      **126** |  **92** | **11** |  **23** |

---

## 2. Area by area

### Menu, folders & views

| Capability                                                                   | Old app                                       | New suite    | What's different or missing                                                                                                                                           | Size |
| ---------------------------------------------------------------------------- | --------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Dashboard at the top of the menu                                             | `public/js/app.js:108-113`                    | **Matched.** | “How we're doing” is the first row. `lib/nav/model.ts`                                                                                                                | –    |
| Your tickets, with a count                                                   | `app.js:14`, `src/routes/tickets.ts:183`      | **Matched.** | Renamed “Your tickets”. `lib/views.ts`                                                                                                                                | –    |
| Unassigned, with a count                                                     | `app.js:15`                                   | **Matched.** | Renamed “Unassigned”.                                                                                                                                                 | –    |
| Open, with a count                                                           | `app.js:16`                                   | **Matched.** | Renamed “Open”.                                                                                                                                                       | –    |
| In progress (we answered, waiting on the customer)                           | `app.js:17`                                   | **Matched.** | Renamed “In progress”.                                                                                                                                                | –    |
| Live chats view                                                              | `app.js:18`, `src/lib/chat.ts`                | **Missing.** | The suite has no website chat.                                                                                                                                        | L    |
| Instagram & Facebook view                                                    | `app.js:19`, `src/lib/meta.ts`                | **Missing.** | The suite's help desk has no Instagram or Facebook messages.                                                                                                          | L    |
| Snoozed                                                                      | `app.js:20`                                   | **Matched.** | `lib/views.ts`; a snooze needs no timer.                                                                                                                              | –    |
| Mentions (notes that @name you)                                              | `app.js:21`, `tickets.ts:60-66`               | **Matched.** | `lib/views.ts` (`mentions`), read from `ticket_notes.mentions` by the inbox.                                                                                          | –    |
| Closed                                                                       | `app.js:22`                                   | **Matched.** | `lib/views.ts`.                                                                                                                                                       | –    |
| More: All tickets                                                            | `app.js:25`                                   | **Matched.** | “All tickets”, under More.                                                                                                                                            | –    |
| More: Archived                                                               | `app.js:26`                                   | **Matched.** | `tickets.shelf`, `shelve_ticket()`; comes back when the customer writes. `mig/20270107000100`, `lib/views.ts`                                                         | –    |
| More: Spam                                                                   | `app.js:27`                                   | **Matched.** | Stays put when more mail arrives; “Not spam” reopens it; the menu shows how many. (As in the old app, a new email from the same sender is still a new conversation.)  | –    |
| More: Trash (delete and restore)                                             | `app.js:28`                                   | **Matched.** | Delete and Restore for everyone; “Delete for good” and “Empty Trash” for owners and admins (the old app never removes anything; neither empties the Trash by itself). | –    |
| Folders people make (“Repairs”), with “+” in the menu and a count            | `app.js:122-134`, `src/lib/folders.ts`        | **Matched.** | `ticket_folders` (managers make them, anyone files). `mig/20270105000100`, `desk/desk-tools.tsx`, `lib/nav/model.ts`                                                  | –    |
| A filed ticket leaves the inbox views but stays in All, Closed and searches  | `tickets.ts:43,116-119`                       | **Matched.** | `inView()` in `lib/views.ts`.                                                                                                                                         | –    |
| A folder lights up when a customer writes back into it                       | `tickets.ts:198-201`                          | **Partly.**  | The folder's count is shown; unread ones carry the dot in the list, but the menu row has no separate unread mark.                                                     | S    |
| Saved views (name + filters) with live counts                                | `tickets.ts:67-72,167-175`, `inbox.js:91-109` | **Matched.** | A config (`helpdesk` / `saved_views`), `lib/saved-views.ts`; counted by the inbox from what it has read.                                                              | –    |
| Views grouped under their own headings in the menu                           | `app.js:135-137,220`                          | **Missing.** | All saved views sit under one “Views” heading.                                                                                                                        | S    |
| Store links in the same menu: Shipping (with count), Repair manual, Settings | `app.js:139-142`                              | **Partly.**  | Shipping is its own tool on the rail; Settings is at the foot of the menu; there is no repair manual.                                                                 | –    |

### List column

| Capability                                                             | Old app                                      | New suite    | What's different or missing                                                                                                                         | Size |
| ---------------------------------------------------------------------- | -------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Heading is the folder you are in, with how many are listed (“50+”)     | `inbox.js:53,249`                            | **Matched.** | `desk/page.tsx`                                                                                                                                     | –    |
| Search names, emails, subjects and #numbers                            | `inbox.js:47,209-213`                        | **Matched.** | `desk/page.tsx` (`q`).                                                                                                                              | –    |
| Search the text of every message                                       | `inbox.js:214-220`, `tickets.ts` (`deep`)    | **Matched.** | `search_ticket_messages()` runs as the member. `mig/20270105000100`                                                                                 | –    |
| Filter by tag, assignee, priority, unread only; sort five ways         | `inbox.js:62-89`                             | **Matched.** | `desk/desk-tools.tsx`, `lib/list.ts`; all in the address.                                                                                           | –    |
| “Save as view” from the filters                                        | `inbox.js:91-109`                            | **Matched.** | `desk/desk-tools.tsx` → `saveView` (owners and admins: views are a config).                                                                         | –    |
| New email: start a conversation with a customer                        | `composer.js:552-615`                        | **Matched.** | `start_ticket()` + `desk/desk-tools.tsx`.                                                                                                           | –    |
| Refresh / check for new mail now                                       | `inbox.js:48,221-227`                        | **Matched.** | Refresh re-reads; mail arrives by webhook, so there is nothing to poll at the mail service.                                                         | –    |
| Export the view as a spreadsheet                                       | `inbox.js:112`, `tickets.ts` (`export.csv`)  | **Matched.** | `lib/export.ts`, the arrow above the list or the ticked rows; owners and admins; the same columns, no message text.                                 | –    |
| Keyboard shortcuts sheet (?)                                           | `inbox.js:382-391`                           | **Matched.** | `desk/desk-tools.tsx`.                                                                                                                              | –    |
| Row: who wrote, and how long ago                                       | `inbox.js:269-271`                           | **Matched.** | Name and “8h”, “1d”. `lib/list.ts` (`timeAgo`)                                                                                                      | –    |
| Row: unread dot, per person; mark read / unread                        | `inbox.js:262,309-316`, `tickets.ts:280,354` | **Matched.** | `ticket_reads` (each person's own). `mig/20270105000100`                                                                                            | –    |
| Row: channel icon and chip (chat, Instagram, Facebook)                 | `inbox.js:272-273`                           | **Partly.**  | Email rows look as they do in the old app (no chip); there are no other channels to mark.                                                           | L    |
| Row: subject                                                           | `inbox.js:272`                               | **Matched.** | `desk/page.tsx`.                                                                                                                                    | –    |
| Row: two-line preview of the last message                              | `inbox.js:274`                               | **Matched.** | `ticket_list_facts()` (worked out on read, never stored).                                                                                           | –    |
| Row: assignee's initials and first name, or “Unassigned”               | `inbox.js:279-281`                           | **Matched.** | `desk/page.tsx`                                                                                                                                     | –    |
| Row: number of messages                                                | `inbox.js:283`                               | **Matched.** | `ticket_list_facts()`.                                                                                                                              | –    |
| Row: priority, status in mixed views, snoozed-until, tags, folder chip | `inbox.js:272-283`                           | **Matched.** | All five. `desk/page.tsx`                                                                                                                           | –    |
| Tick several rows and act on them together                             | `inbox.js:117-204`                           | **Matched.** | `desk/bulk.tsx` → `bulk_update_tickets()`: close, assign, folder, snooze, tag, archive, spam, trash, export. No bulk priority, read marks or merge. | –    |
| The list re-reads itself every 30 seconds                              | `inbox.js:361`                               | **Matched.** | `desk/desk-tools.tsx` (`Freshen`)                                                                                                                   | –    |
| “Show more” for long lists                                             | `inbox.js:57,228`                            | **Matched.** | 200 at a time, up to 1,000 (`n` in the address).                                                                                                    | –    |
| Opens the first conversation by itself on a wide screen                | `inbox.js:371-373`                           | **Matched.** | A setting, on to begin with. `desk/bulk.tsx` (`AutoOpen`)                                                                                           | –    |
| Friendly empty states (“Inbox zero”)                                   | `inbox.js:250-258`                           | **Matched.** | `desk/page.tsx`.                                                                                                                                    | –    |

### Ticket header & actions

| Capability                                                                                    | Old app                 | New suite    | What's different or missing                                                                          | Size |
| --------------------------------------------------------------------------------------------- | ----------------------- | ------------ | ---------------------------------------------------------------------------------------------------- | ---- |
| Title is the subject; click to rename                                                         | `ticket.js:76-103`      | **Matched.** | `set_ticket_subject()`, `desk/desk-tools.tsx`                                                        | –    |
| “#12 · customer · opened 16h ago”                                                             | `ticket.js:146-149`     | **Matched.** | `desk/desk-tools.tsx`                                                                                | –    |
| Status control: Open, In progress, Snooze…, Closed                                            | `common.js:50-56`       | **Matched.** | `desk/desk-tools.tsx` (`StatusMenu`)                                                                 | –    |
| Close / Reopen button                                                                         | `ticket.js:80-87`       | **Matched.** | `desk/page.tsx`.                                                                                     | –    |
| ⋯ menu: in progress, snooze, merge, folder, assign, assign to me, priority, tags, mark unread | `ticket.js:119-137`     | **Matched.** | `desk/desk-tools.tsx` (`MoreMenu`)                                                                   | –    |
| ⋯ menu: Archive, Mark as spam, Delete                                                         | `ticket.js:123,135-136` | **Matched.** | `desk/desk-tools.tsx`; “Delete for good” from the Trash for owners and admins.                       | –    |
| ⋯ menu: Add to repair manual                                                                  | `ticket.js:132,433-443` | **Missing.** | No repair manual (see below).                                                                        | L    |
| Snooze presets and a date and time of your own                                                | `common.js:22-48`       | **Matched.** | Presets plus a date-time box.                                                                        | –    |
| Merge with suggestions from the same customer, several at once                                | `ticket.js:447-481`     | **Partly.**  | The merge box offers the customer's other open conversations or takes a number; still one at a time. | S    |
| After closing: next ticket, back to the list, or stay (a setting)                             | `ticket.js:39-41`       | **Matched.** | `helpdesk` / `desk_settings` (`after_close`), Settings → Help desk.                                  | –    |
| Keyboard: j k / c r n f e s a t p m v                                                         | `inbox.js:333-359`      | **Partly.**  | j k / c r n f e s m u ?; a t p v open the rail's pickers. No x (ticking rows) or Alt shortcuts.      | S    |

### Conversation

| Capability                                                                                                               | Old app                            | New suite    | What's different or missing                                                                                                                                                                                                                           | Size |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Messages as cards: customer on the left, the team on a tinted ground on the right, with initials, name, address and time | `ticket.js:369-427`                | **Matched.** | `desk/page.tsx`                                                                                                                                                                                                                                       | –    |
| “to customer@…” on what the team sent                                                                                    | `ticket.js:369-427`                | **Matched.** | `messages.to_emails`, `desk/page.tsx`                                                                                                                                                                                                                 | –    |
| Internal notes in the thread, with @names picked out                                                                     | `ticket.js:274-276,294-299`        | **Matched.** | `desk/page.tsx`                                                                                                                                                                                                                                       | –    |
| What happened, in the thread (“took this ticket”, “marked closed”)                                                       | `ticket.js:250,278`                | **Matched.** | `ticket_events` (written only by a trigger), `lib/activity.ts`                                                                                                                                                                                        | –    |
| Earlier messages folded away, the last two left open                                                                     | `ticket.js:281-291`                | **Matched.** | `lib/thread.ts` (`foldThread`)                                                                                                                                                                                                                        | –    |
| The quoted earlier email folded under “…”                                                                                | `ticket.js:359-366`                | **Matched.** | `lib/thread.ts` (`quoteStart`, ported with its tests)                                                                                                                                                                                                 | –    |
| Designed (HTML) email shown as sent, in a locked frame                                                                   | `ticket.js:369-400`                | **Missing.** | By rule the suite shows customer email as plain text only.                                                                                                                                                                                            | –    |
| Pictures in the email and attachment chips with their size                                                               | `ticket.js:400-427`                | **Matched.** | Kept in a private bucket and listed in `message_attachments`; set-in pictures shown where the email put them, the rest as thumbnails and chips. Only the kinds on a short list are kept. `lib/files.ts`, `desk/attachments.tsx`, `mig/20270106000100` | –    |
| Several email threads in one ticket, with subject dividers                                                               | `ticket.js:259-271`                | **Missing.** | One subject per conversation.                                                                                                                                                                                                                         | S    |
| Live chat bubbles and chat reply box; reply under a comment or by DM                                                     | `chat-agent.js`, `social-agent.js` | **Missing.** | No chat or social channels.                                                                                                                                                                                                                           | L    |

### Composer

| Capability                                                          | Old app                                     | New suite    | What's different or missing                                                                                                                                   | Size |
| ------------------------------------------------------------------- | ------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Reply                                                               | `composer.js:231-470`                       | **Matched.** | `desk/composer.tsx`                                                                                                                                           | –    |
| Reply all (copies in everyone on the customer's last email)         | `composer.js:242-247`                       | **Matched.** | Who else an email went to is kept (`messages.to_emails` / `cc_emails`); the business's own addresses are left out. `lib/outbound.ts` (`replyAllCopies`)       | –    |
| Forward to someone else                                             | `composer.js:253,281`                       | **Matched.** | `record_outbound(kind 'forward')`, quoted conversation added by `lib/outbound.ts`                                                                             | –    |
| Internal note, with an @name picker                                 | `composer.js:299-345`                       | **Matched.** | Type @ and pick. `desk/composer.tsx`                                                                                                                          | –    |
| Edit To, Cc and Bcc                                                 | `composer.js:249-266`                       | **Matched.** | `desk/composer.tsx`, `lib/outbound.ts` (`parseRecipients`)                                                                                                    | –    |
| Formatting bar: bold, italic, underline, strike, lists, link, clear | `composer.js:96-116`                        | **Matched.** | `lib/rich.ts`: the editor hands over a small document; the server writes the HTML and the plain-text part itself.                                             | –    |
| Pasted text keeps simple formatting                                 | `composer.js:37-56,98-103`                  | **Partly.**  | A paste comes in as plain text.                                                                                                                               | S    |
| Attach files to a reply                                             | `composer.js:77-91,268-273`                 | **Matched.** | Sent with the email (up to 4 MB together) and kept with the conversation; a forward takes the conversation's files along (8 MB together).                     | –    |
| Macros: search, pick, placeholders filled                           | `composer.js:120-170`, `src/lib/macros.ts`  | **Matched.** | With a search box. `desk/composer.tsx`                                                                                                                        | –    |
| A macro can also act on send (set status, add tags)                 | `composer.js:172-181,275-277`               | **Matched.** | A saved reply can add tags, set what happens next and hand off (`templateActionsSchema`), shown as “On send” chips. `apply_send_actions()`                    | –    |
| Discount code made in the shop and dropped into the reply           | `composer.js:183-204`                       | **Missing.** | Needs permission to write discounts in the shop, which the suite doesn't ask for.                                                                             | M    |
| AI draft, with a line saying what to say                            | `composer.js:347-379`                       | **Matched.** | A hint box; the hint is marked as the team's own words. Never sent by itself.                                                                                 | –    |
| Two or three suggested replies to pick from                         | `composer.js:478-548`, `src/lib/suggest.ts` | **Missing.** | One draft at a time. The old app writes its suggestions by itself for every new ticket; here AI runs only on a person's press, against the plan's allowance.  | S    |
| Send (marks in progress)                                            | `composer.js:382`                           | **Matched.** | `desk/composer.tsx`                                                                                                                                           | –    |
| Send & close                                                        | `composer.js:381`                           | **Matched.** | The one filled button.                                                                                                                                        | –    |
| Send ▾: keep open, snooze…, close                                   | `composer.js:384-389`                       | **Matched.** | `record_outbound(p_then)`.                                                                                                                                    | –    |
| A few seconds to undo a send                                        | `composer.js:207-228`                       | **Matched.** | A wait on the server, not in the browser: the email sits in an outbox, the worker sends it, “Undo” takes it back. `mig/20270108000100`, `desk/send-watch.tsx` | –    |
| Discard draft                                                       | `composer.js:392-394`                       | **Matched.** | Not there.                                                                                                                                                    | –    |
| Unsent drafts kept per ticket in the browser                        | `composer.js:232-234,275`                   | **Matched.** | `lib/drafts.ts`, in the browser only.                                                                                                                         | –    |
| ⌘↵ sends, ⌘⇧↵ sends and closes                                      | `composer.js:456-470`                       | **Matched.** | Not there.                                                                                                                                                    | –    |
| Mail goes out from the business's own Gmail address                 | `src/lib/gmail.ts`                          | **Missing.** | The suite sends from the workspace's support address through its own mail service.                                                                            | L    |

### Details rail

| Capability                                                      | Old app                                          | New suite    | What's different or missing                                                                                                                                                 | Size |
| --------------------------------------------------------------- | ------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Details / Activity tabs; rail folds away                        | `ticket.js:166-230`                              | **Matched.** | `desk/page.tsx`; the tab is in the address (`side`).                                                                                                                        | –    |
| Assignee, changed in place                                      | `ticket.js:174-175`                              | **Matched.** | `desk/desk-tools.tsx`                                                                                                                                                       | –    |
| Priority, changed in place                                      | `ticket.js:176-178`                              | **Matched.** | `desk/desk-tools.tsx` (“Normal” is the suite's “None”).                                                                                                                     | –    |
| Folder, changed in place                                        | `ticket.js:185-190`                              | **Matched.** | `file_ticket()`.                                                                                                                                                            | –    |
| Status, “Back on”, Created, Last message                        | `ticket.js:191-194`                              | **Matched.** | `desk/page.tsx`                                                                                                                                                             | –    |
| Tags as chips: remove one, find or make one                     | `ticket.js:179-180,196-198`, `common.js:113-150` | **Matched.** | `desk/desk-tools.tsx` (`TagEditor`)                                                                                                                                         | –    |
| Tags in groups                                                  | `common.js:136-141`                              | **Matched.** | A config (`helpdesk` / `tag_groups`), `lib/tag-groups.ts`; the tag picker shows them under their headings.                                                                  | –    |
| AI insights: a short summary, the mood, the kind of request     | `ticket.js:200-219`, `src/lib/ai.ts`             | **Matched.** | `lib/insights.ts`, kept on the ticket by `set_ticket_insights()`; counted against the AI allowance.                                                                         | –    |
| Customer: “View on Shopify”                                     | `ticket.js:519`                                  | **Matched.** | A plain link built from the connected shop's name. `lib/customer.ts` (`shopLinks`)                                                                                          | –    |
| Customer: initials, name, email with copy                       | `ticket.js:520-527`                              | **Matched.** | `desk/page.tsx`                                                                                                                                                             | –    |
| Customer: phone                                                 | `ticket.js:527`                                  | **Partly.**  | The phone on their latest order's ship-to; the shop's own customer record isn't synced.                                                                                     | S    |
| Tiles: orders, lifetime, last order                             | `ticket.js:528-531`                              | **Matched.** | Worked out on read. `lib/customer.ts` (`customerTiles`)                                                                                                                     | –    |
| The shop's tags on the customer                                 | `ticket.js:532`                                  | **Missing.** | The sync doesn't store customer tags.                                                                                                                                       | S    |
| The shop's note on the customer                                 | `ticket.js:533`                                  | **Missing.** | The sync doesn't store it.                                                                                                                                                  | S    |
| “New email” to this customer                                    | `ticket.js:538-539`                              | **Matched.** | `desk/desk-tools.tsx`                                                                                                                                                       | –    |
| Orders, with how many                                           | `ticket.js:541-543`                              | **Matched.** | The last eight, with the full count.                                                                                                                                        | –    |
| Order card: name, date, total, Paid / Fulfilled / Cancelled     | `ticket.js:563-570`                              | **Matched.** | Badges with words. `desk/page.tsx`                                                                                                                                          | –    |
| Items with the option's photo and quantity                      | `ticket.js:572-575`                              | **Matched.** | Photos from Stock's synced items (`variant_image_url`), only from the shop platform's image servers.                                                                        | –    |
| Tracking: status and a link to the carrier                      | `ticket.js:576-580`                              | **Partly.**  | Parcels recorded in the suite's Shipping, as “Sent” with the carrier, number and link. Whether it was delivered isn't known, and parcels fulfilled elsewhere aren't synced. | S    |
| Ship to, with the delivery method and address                   | `ticket.js:581-583`                              | **Matched.** | From `shipping_orders`, read as the member.                                                                                                                                 | –    |
| The order's note                                                | `ticket.js:584`                                  | **Matched.** | `shipping_orders.note`.                                                                                                                                                     | –    |
| “Add to reply”: the order as plain text                         | `ticket.js:494-499,586`                          | **Matched.** | `lib/customer.ts` (`orderSummaryText`)                                                                                                                                      | –    |
| “Ship” / “Label”: open the order in Shipping                    | `ticket.js:587`                                  | **Matched.** | Shown when the order is still to ship and the workspace has Shipping.                                                                                                       | –    |
| Open the order in the shop                                      | `ticket.js:588`                                  | **Matched.** | `shopLinks`.                                                                                                                                                                | –    |
| Earlier conversations, with a nudge to merge open ones          | `ticket.js:545-550`                              | **Matched.** | `desk/page.tsx`                                                                                                                                                             | –    |
| Activity: everything that happened, newest first, with a filter | `ticket.js:332-346`                              | **Matched.** | Also tag changes (by a person or a rule), archive, spam and trash. `lib/activity.ts`                                                                                        | –    |

### Numbers

| Capability                                                | Old app                                                     | New suite    | What's different or missing                                                             | Size |
| --------------------------------------------------------- | ----------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------- | ---- |
| Support numbers: volume, time to first reply, by teammate | `public/js/analytics.js:203-262`, `src/routes/analytics.ts` | **Partly.**  | `desk/reports/page.tsx` has the counts and reply times; no “when tickets arrive” chart. | S    |
| What AI has cost, by day and feature                      | `analytics.js:144-160`, `src/lib/usage.ts`                  | **Missing.** | The suite meters AI against the plan's allowance; there is no cost page.                | S    |

### Settings & automation

| Capability                                                                | Old app                                      | New suite    | What's different or missing                                                      | Size |
| ------------------------------------------------------------------------- | -------------------------------------------- | ------------ | -------------------------------------------------------------------------------- | ---- |
| Saved replies with placeholders                                           | `src/lib/macros.ts`, `public/js/settings.js` | **Matched.** | `lib/config.ts`, Settings → Help desk.                                           | –    |
| Rules: on new mail, tag / set priority / assign                           | `src/lib/rules.ts`                           | **Matched.** | `lib/config.ts` (`actionsFor`), `apply_ticket_rules()`.                          | –    |
| Rules that run on a reply or a status change, and auto-reply with a macro | `src/lib/rules.ts:60-114`                    | **Missing.** | Rules run on new mail only and never send anything.                              | M    |
| Hand out new tickets by turns or by load                                  | `src/lib/rules.ts`, `settings-support.js`    | **Missing.** | A rule can name one person.                                                      | S    |
| Signature, undo seconds, what happens after closing                       | `settings-support.js`                        | **Partly.**  | Undo seconds and what happens after closing are settings; there is no signature. | S    |
| Bring in older email as closed tickets                                    | `src/lib/gmail.ts` (import)                  | **Missing.** | Only mail that arrives from now on.                                              | L    |
| “AI knowledge” entries that guide drafts                                  | `src/lib/kb.ts`, `src/lib/ai.ts`             | **Missing.** | Drafts use saved replies, orders and Stock.                                      | M    |

### Channels

| Capability                                   | Old app                                                  | New suite    | What's different or missing                                                                                                                                  | Size |
| -------------------------------------------- | -------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| Email                                        | `src/lib/gmail.ts` (the business's own Gmail, both ways) | **Partly.**  | Email reaches the suite by forwarding to the workspace's support address; replies thread back by a reply key. Nothing is archived in the business's mailbox. | L    |
| Website live chat                            | `src/lib/chat.ts`, `src/routes/chat-public.ts`           | **Missing.** | Not in the suite.                                                                                                                                            | L    |
| Instagram and Facebook messages and comments | `src/lib/meta.ts`, `src/routes/social.ts`                | **Missing.** | The suite's Social tool posts; it doesn't read messages.                                                                                                     | L    |

### Repair manual & knowledge base

| Capability                                                                                 | Old app                                                            | New suite    | What's different or missing    | Size |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------ | ------------------------------ | ---- |
| Repair topics written by AI from finished repair conversations, with the customer's photos | `public/js/manual.js`, `src/lib/manual.ts`, `src/routes/manual.ts` | **Missing.** | Not built. See the plan below. | L    |
| Topics can be edited, published and searched; “New topic”                                  | `manual.js:60-324`                                                 | **Missing.** | Not built.                     | L    |
| Knowledge base: articles, pulled-in pages, links, merge suggestions                        | `public/js/kb.js`, `src/lib/kb*.ts`, `src/routes/kb.ts`            | **Missing.** | Not built.                     | L    |
| Published topics and articles guide AI drafts                                              | `src/lib/ai.ts`, `src/lib/site-knowledge.ts`                       | **Missing.** | Not built.                     | M    |

### Only in the suite (not counted)

- Tags as one-press filters in the menu, kept beside the view you are in.
- “Back in stock?”: what Stock says about the things this customer bought.
- Customer email is never rendered as HTML, and a person forgotten in the shop is forgotten here too.

---

## 3. Left out on purpose, and what each would need

| Left out                                        | Why                                                      | What it needs                                                                    |
| ----------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Live chat view and chat replies                 | The suite has no website chat.                           | A chat widget, a public endpoint and a channel on tickets: a feature of its own. |
| Instagram & Facebook view                       | The Social tool only posts.                              | Meta's messaging permissions (a new app review) and a webhook.                   |
| Discount codes                                  | The shop connection can't write discounts.               | A new shop permission (`write_discounts`) and the owner's go-ahead.              |
| HTML email as sent                              | A rule here: customer email is shown as plain text only. | A decision to change the rule, then a locked frame.                              |
| Customer tags, note and phone from the shop     | The sync stores a customer's name and email only.        | Three columns and the sync asking for them (no new permission).                  |
| Tracking for parcels not sent through the suite | The sync doesn't store the shop's fulfilments.           | Reading fulfilments in the order sync.                                           |
| Suggested replies                               | The old app writes them unasked for every new ticket.    | A decision to let AI run without a press, or a “suggest three” button.           |

---

## 4. Repair manual and knowledge base: how the old one works, and a plan

**How it works in the old app.** `src/lib/manual.ts` reads a finished repair conversation (the customer's messages, the team's replies, the photos and videos sent) and asks the AI whether it holds a repair. If it does, the AI either adds a case to an existing topic or writes a new one: a title, the machine, the symptoms, the steps that fixed it, written as simple Markdown (`public/js/manual.js` renders it with its own small, escaping renderer). Each topic keeps a running record of its cases with links back to the tickets and the customer's media. A person can edit a topic, write one from scratch (“New topic”), search by topic, machine or symptom, and publish it. Published topics are handed to the AI when it drafts replies (`src/lib/ai.ts`). A full scan reads past repair tickets in batches; “Add to repair manual” on a ticket reads just that one. The knowledge base beside it (`public/js/kb.js`, `src/lib/kb.ts`, `kb-pull.ts`, `kb-links.ts`, `kb-merge.ts`) holds articles: written by hand, pulled in from the shop's own help pages, cross-linked, with merge suggestions for near-duplicates, and also fed to drafts.

**A plan for the suite (not built).**

1. Tables `manual_topics` (title, machine, symptoms, body as Markdown, published, tenant_id, RLS) and `manual_cases` (topic, ticket, what was learned); cross-tenant tests. Writes through manager-only functions; the whole team reads.
2. A pure reader in `lib/helpdesk/manual/`: structured output, no tools, the conversation marked as material, the answer only ever data (the bills-by-email reader is the pattern). Counted against the AI allowance.
3. “Add to repair manual” on a ticket (a person's press), then an optional worker pass over closed tickets tagged by a rule. Nothing is published without a person.
4. A place in the menu (“Repair manual”) with search, a topic page, an editor and “New topic”; Markdown rendered as React nodes, never as HTML.
5. Published topics added to the draft prompt as data, capped.
6. The knowledge base as a second kind of entry in the same tables; pulling pages from a website needs a decision first (the suite fetches nothing a person types today).

Customer photos are now kept with their conversation (`message_attachments`), so a topic can point at them.

---

## 5. Not checked against the real thing

- No real email was sent or received: sending goes through the same mail service as before, with Cc, Bcc, an HTML part and attachments added to the request, and that request is covered by tests, not by a delivery.
- No real shop was read: the customer and orders in the rail were looked at with made-up rows shaped like what the sync stores.
- Claude's summary and the draft hint were not run against the API here; the prompts and the tidying are tested.
- The migrations run in the test database here; applying them elsewhere is done outside this repo.
- No real email with attachments was received: the mail service's attachment fields (name, content, type, content id, length) are read as its documentation describes them, and tested with made-up payloads. How each mail app marks a set-in picture in its plain text (“[cid:…]”, “[image: name]”) is from the apps we know of; one that leaves no mark gets its picture under the message instead.
- Storage itself is not in the test database: the bucket's row and its policy are tested, uploading and downloading are not.
- Undo send needs the worker running; the wait, taking back, a refusal and a send that never finished are tested in the database, not against the mail service.
- The owner's “only the signature showed” email wasn't available. The cause found in the code (the mail service's own guess at “just the reply” was preferred over the whole text) is fixed and tested with made-up emails.
