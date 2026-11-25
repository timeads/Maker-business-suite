# Help desk: the owner's help desk app vs. the suite, side by side

Written 25 Nov 2026, before the rebuild, and kept up to date as gaps close. The old app was only read.

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
- After the rebuild: filled in as the pieces land.

| Area                           | Capabilities | Matched | Partly | Missing |
| ------------------------------ | -----------: | ------: | -----: | ------: |
| Menu, folders & views          |           20 |       7 |      2 |      11 |
| List column                    |           22 |       4 |      4 |      14 |
| Ticket header & actions        |           11 |       1 |      7 |       3 |
| Conversation                   |           10 |       1 |      1 |       8 |
| Composer                       |           21 |       2 |      3 |      16 |
| Details rail                   |           26 |       1 |      8 |      17 |
| Numbers                        |            2 |       0 |      1 |       1 |
| Settings & automation          |            7 |       2 |      0 |       5 |
| Channels                       |            3 |       0 |      1 |       2 |
| Repair manual & knowledge base |            4 |       0 |      0 |       4 |
| **Total**                      |      **126** |  **18** | **27** |  **81** |

---

## 2. Area by area

### Menu, folders & views

| Capability                                                                   | Old app                                       | New suite    | What's different or missing                                                                           | Size |
| ---------------------------------------------------------------------------- | --------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------- | ---- |
| Dashboard at the top of the menu                                             | `public/js/app.js:108-113`                    | **Partly.**  | The numbers page exists (`desk/reports`) but sits under “More” at the foot of the menu.               | –    |
| Your tickets, with a count                                                   | `app.js:14`, `src/routes/tickets.ts:183`      | **Matched.** | `lib/views.ts` (“Assigned to me”).                                                                    | –    |
| Unassigned, with a count                                                     | `app.js:15`                                   | **Matched.** | `lib/views.ts` (“Nobody has it”).                                                                     | –    |
| Open, with a count                                                           | `app.js:16`                                   | **Matched.** | `lib/views.ts` (“Needs a reply”).                                                                     | –    |
| In progress (we answered, waiting on the customer)                           | `app.js:17`                                   | **Matched.** | `lib/views.ts` (“Waiting on customer”; the suite's `pending`).                                        | –    |
| Live chats view                                                              | `app.js:18`, `src/lib/chat.ts`                | **Missing.** | The suite has no website chat.                                                                        | L    |
| Instagram & Facebook view                                                    | `app.js:19`, `src/lib/meta.ts`                | **Missing.** | The suite's help desk has no Instagram or Facebook messages.                                          | L    |
| Snoozed                                                                      | `app.js:20`                                   | **Matched.** | `lib/views.ts`; a snooze needs no timer.                                                              | –    |
| Mentions (notes that @name you)                                              | `app.js:21`, `tickets.ts:60-66`               | **Missing.** | Notes store who was mentioned, but no view lists them.                                                | –    |
| Closed                                                                       | `app.js:22`                                   | **Matched.** | `lib/views.ts`.                                                                                       | –    |
| More: All tickets                                                            | `app.js:25`                                   | **Matched.** | “Everything”.                                                                                         | –    |
| More: Archived                                                               | `app.js:26`                                   | **Missing.** | The suite has three states (open, in progress, closed) plus snooze.                                   | S    |
| More: Spam                                                                   | `app.js:27`                                   | **Missing.** | No spam state; nothing is filtered.                                                                   | S    |
| More: Trash (delete and restore)                                             | `app.js:28`                                   | **Missing.** | Nothing can be deleted by hand.                                                                       | S    |
| Folders people make (“Repairs”), with “+” in the menu and a count            | `app.js:122-134`, `src/lib/folders.ts`        | **Missing.** | No folders.                                                                                           | –    |
| A filed ticket leaves the inbox views but stays in All, Closed and searches  | `tickets.ts:43,116-119`                       | **Missing.** | No folders.                                                                                           | –    |
| A folder lights up when a customer writes back into it                       | `tickets.ts:198-201`                          | **Missing.** | No folders.                                                                                           | S    |
| Saved views (name + filters) with live counts                                | `tickets.ts:67-72,167-175`, `inbox.js:91-109` | **Missing.** | No saved views.                                                                                       | –    |
| Views grouped under their own headings in the menu                           | `app.js:135-137,220`                          | **Missing.** | All saved views sit under one “Views” heading.                                                        | S    |
| Store links in the same menu: Shipping (with count), Repair manual, Settings | `app.js:139-142`                              | **Partly.**  | Shipping is its own tool on the rail; Settings is at the foot of the menu; there is no repair manual. | –    |

### List column

| Capability                                                             | Old app                                      | New suite    | What's different or missing                        | Size |
| ---------------------------------------------------------------------- | -------------------------------------------- | ------------ | -------------------------------------------------- | ---- |
| Heading is the folder you are in, with how many are listed (“50+”)     | `inbox.js:53,249`                            | **Partly.**  | Heading only.                                      | –    |
| Search names, emails, subjects and #numbers                            | `inbox.js:47,209-213`                        | **Matched.** | `desk/page.tsx` (`q`).                             | –    |
| Search the text of every message                                       | `inbox.js:214-220`, `tickets.ts` (`deep`)    | **Missing.** | Search never reads message text.                   | –    |
| Filter by tag, assignee, priority, unread only; sort five ways         | `inbox.js:62-89`                             | **Missing.** | Only a tag filter (from the menu).                 | –    |
| “Save as view” from the filters                                        | `inbox.js:91-109`                            | **Missing.** | Not there.                                         | –    |
| New email: start a conversation with a customer                        | `composer.js:552-615`                        | **Missing.** | A conversation only starts when a customer writes. | –    |
| Refresh / check for new mail now                                       | `inbox.js:48,221-227`                        | **Missing.** | No button.                                         | –    |
| Export the view as a spreadsheet                                       | `inbox.js:112`, `tickets.ts` (`export.csv`)  | **Missing.** | No export.                                         | S    |
| Keyboard shortcuts sheet (?)                                           | `inbox.js:382-391`                           | **Partly.**  | A one-line hint under the list.                    | –    |
| Row: who wrote, and how long ago                                       | `inbox.js:269-271`                           | **Matched.** | Name and a clock time or date.                     | –    |
| Row: unread dot, per person; mark read / unread                        | `inbox.js:262,309-316`, `tickets.ts:280,354` | **Missing.** | No read state.                                     | –    |
| Row: channel icon and chip (chat, Instagram, Facebook)                 | `inbox.js:272-273`                           | **Missing.** | Email is the only channel.                         | L    |
| Row: subject                                                           | `inbox.js:272`                               | **Matched.** | `desk/page.tsx`.                                   | –    |
| Row: two-line preview of the last message                              | `inbox.js:274`                               | **Missing.** | No preview.                                        | –    |
| Row: assignee's initials and first name, or “Unassigned”               | `inbox.js:279-281`                           | **Partly.**  | Initials only.                                     | –    |
| Row: number of messages                                                | `inbox.js:283`                               | **Missing.** | Not shown.                                         | –    |
| Row: priority, status in mixed views, snoozed-until, tags, folder chip | `inbox.js:272-283`                           | **Partly.**  | Priority, snoozed and tags.                        | –    |
| Tick several rows and act on them together                             | `inbox.js:117-204`                           | **Missing.** | One conversation at a time.                        | M    |
| The list re-reads itself every 30 seconds                              | `inbox.js:361`                               | **Missing.** | Only on a page load.                               | –    |
| “Show more” for long lists                                             | `inbox.js:57,228`                            | **Missing.** | The first 200.                                     | S    |
| Opens the first conversation by itself on a wide screen                | `inbox.js:371-373`                           | **Missing.** | You pick one.                                      | S    |
| Friendly empty states (“Inbox zero”)                                   | `inbox.js:250-258`                           | **Matched.** | `desk/page.tsx`.                                   | –    |

### Ticket header & actions

| Capability                                                                                    | Old app                 | New suite    | What's different or missing                                                                 | Size |
| --------------------------------------------------------------------------------------------- | ----------------------- | ------------ | ------------------------------------------------------------------------------------------- | ---- |
| Title is the subject; click to rename                                                         | `ticket.js:76-103`      | **Partly.**  | Shown, not editable.                                                                        | –    |
| “#12 · customer · opened 16h ago”                                                             | `ticket.js:146-149`     | **Partly.**  | Number, name and email.                                                                     | –    |
| Status control: Open, In progress, Snooze…, Closed                                            | `common.js:50-56`       | **Partly.**  | A badge, plus separate Close and Snooze menus.                                              | –    |
| Close / Reopen button                                                                         | `ticket.js:80-87`       | **Matched.** | `desk/page.tsx`.                                                                            | –    |
| ⋯ menu: in progress, snooze, merge, folder, assign, assign to me, priority, tags, mark unread | `ticket.js:119-137`     | **Partly.**  | Three small menus and a join form; no “assign to me”, folder or unread.                     | –    |
| ⋯ menu: Archive, Mark as spam, Delete                                                         | `ticket.js:123,135-136` | **Missing.** | Those states don't exist in the suite.                                                      | S    |
| ⋯ menu: Add to repair manual                                                                  | `ticket.js:132,433-443` | **Missing.** | No repair manual (see below).                                                               | L    |
| Snooze presets and a date and time of your own                                                | `common.js:22-48`       | **Partly.**  | Five presets.                                                                               | –    |
| Merge with suggestions from the same customer, several at once                                | `ticket.js:447-481`     | **Partly.**  | Joined one at a time, by number; the customer's other conversations are listed in the rail. | S    |
| After closing: next ticket, back to the list, or stay (a setting)                             | `ticket.js:39-41`       | **Missing.** | Stays on the closed conversation.                                                           | S    |
| Keyboard: j k / c r n f e s a t p m v                                                         | `inbox.js:333-359`      | **Partly.**  | j k r n e u.                                                                                | S    |

### Conversation

| Capability                                                                                                               | Old app                            | New suite    | What's different or missing                                    | Size |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ------------ | -------------------------------------------------------------- | ---- |
| Messages as cards: customer on the left, the team on a tinted ground on the right, with initials, name, address and time | `ticket.js:369-427`                | **Partly.**  | Bubbles with a name and time.                                  | –    |
| “to customer@…” on what the team sent                                                                                    | `ticket.js:369-427`                | **Missing.** | Not shown.                                                     | –    |
| Internal notes in the thread, with @names picked out                                                                     | `ticket.js:274-276,294-299`        | **Matched.** | `desk/page.tsx`.                                               | –    |
| What happened, in the thread (“took this ticket”, “marked closed”)                                                       | `ticket.js:250,278`                | **Missing.** | Nothing is written down.                                       | –    |
| Earlier messages folded away, the last two left open                                                                     | `ticket.js:281-291`                | **Missing.** | Everything is open.                                            | –    |
| The quoted earlier email folded under “…”                                                                                | `ticket.js:359-366`                | **Missing.** | Shown in full.                                                 | –    |
| Designed (HTML) email shown as sent, in a locked frame                                                                   | `ticket.js:369-400`                | **Missing.** | By rule the suite shows customer email as plain text only.     | –    |
| Pictures in the email and attachment chips with their size                                                               | `ticket.js:400-427`                | **Missing.** | The suite keeps the words of an incoming email, not its files. | M    |
| Several email threads in one ticket, with subject dividers                                                               | `ticket.js:259-271`                | **Missing.** | One subject per conversation.                                  | S    |
| Live chat bubbles and chat reply box; reply under a comment or by DM                                                     | `chat-agent.js`, `social-agent.js` | **Missing.** | No chat or social channels.                                    | L    |

### Composer

| Capability                                                          | Old app                                     | New suite    | What's different or missing                                                        | Size |
| ------------------------------------------------------------------- | ------------------------------------------- | ------------ | ---------------------------------------------------------------------------------- | ---- |
| Reply                                                               | `composer.js:231-470`                       | **Matched.** | `desk/reply-form.tsx`.                                                             | –    |
| Reply all (copies in everyone on the customer's last email)         | `composer.js:242-247`                       | **Missing.** | Not there.                                                                         | S    |
| Forward to someone else                                             | `composer.js:253,281`                       | **Missing.** | Not there.                                                                         | –    |
| Internal note, with an @name picker                                 | `composer.js:299-345`                       | **Partly.**  | A note tab; @first-name works when typed, with no picker.                          | S    |
| Edit To, Cc and Bcc                                                 | `composer.js:249-266`                       | **Missing.** | Always to the customer.                                                            | –    |
| Formatting bar: bold, italic, underline, strike, lists, link, clear | `composer.js:96-116`                        | **Missing.** | Plain text only.                                                                   | –    |
| Pasted text keeps simple formatting                                 | `composer.js:37-56,98-103`                  | **Missing.** | Plain text.                                                                        | S    |
| Attach files to a reply                                             | `composer.js:77-91,268-273`                 | **Missing.** | Not there.                                                                         | –    |
| Macros: search, pick, placeholders filled                           | `composer.js:120-170`, `src/lib/macros.ts`  | **Partly.**  | A pick list of saved replies with placeholders filled.                             | –    |
| A macro can also act on send (set status, add tags)                 | `composer.js:172-181,275-277`               | **Missing.** | A saved reply is words only.                                                       | M    |
| Discount code made in the shop and dropped into the reply           | `composer.js:183-204`                       | **Missing.** | Needs permission to write discounts in the shop, which the suite doesn't ask for.  | M    |
| AI draft, with a line saying what to say                            | `composer.js:347-379`                       | **Partly.**  | A draft with no steer.                                                             | –    |
| Two or three suggested replies to pick from                         | `composer.js:478-548`, `src/lib/suggest.ts` | **Missing.** | One draft at a time.                                                               | S    |
| Send (marks in progress)                                            | `composer.js:382`                           | **Matched.** | `desk/reply-form.tsx`.                                                             | –    |
| Send & close                                                        | `composer.js:381`                           | **Missing.** | Send, then close by hand.                                                          | –    |
| Send ▾: keep open, snooze…, close                                   | `composer.js:384-389`                       | **Missing.** | Not there.                                                                         | –    |
| A few seconds to undo a send                                        | `composer.js:207-228`                       | **Missing.** | Sent at once.                                                                      | S    |
| Discard draft                                                       | `composer.js:392-394`                       | **Missing.** | Not there.                                                                         | –    |
| Unsent drafts kept per ticket in the browser                        | `composer.js:232-234,275`                   | **Missing.** | Lost on leaving.                                                                   | –    |
| ⌘↵ sends, ⌘⇧↵ sends and closes                                      | `composer.js:456-470`                       | **Missing.** | Not there.                                                                         | –    |
| Mail goes out from the business's own Gmail address                 | `src/lib/gmail.ts`                          | **Missing.** | The suite sends from the workspace's support address through its own mail service. | L    |

### Details rail

| Capability                                                      | Old app                                          | New suite    | What's different or missing           | Size |
| --------------------------------------------------------------- | ------------------------------------------------ | ------------ | ------------------------------------- | ---- |
| Details / Activity tabs; rail folds away                        | `ticket.js:166-230`                              | **Missing.** | One customer panel.                   | –    |
| Assignee, changed in place                                      | `ticket.js:174-175`                              | **Partly.**  | A menu in the header.                 | –    |
| Priority, changed in place                                      | `ticket.js:176-178`                              | **Partly.**  | A menu in the header.                 | –    |
| Folder, changed in place                                        | `ticket.js:185-190`                              | **Missing.** | No folders.                           | –    |
| Status, “Back on”, Created, Last message                        | `ticket.js:191-194`                              | **Partly.**  | Status badge in the header only.      | –    |
| Tags as chips: remove one, find or make one                     | `ticket.js:179-180,196-198`, `common.js:113-150` | **Partly.**  | A comma-separated box.                | –    |
| Tags in groups                                                  | `common.js:136-141`                              | **Missing.** | One flat list.                        | S    |
| AI insights: a short summary, the mood, the kind of request     | `ticket.js:200-219`, `src/lib/ai.ts`             | **Missing.** | Not there.                            | –    |
| Customer: “View on Shopify”                                     | `ticket.js:519`                                  | **Missing.** | No link.                              | –    |
| Customer: initials, name, email with copy                       | `ticket.js:520-527`                              | **Partly.**  | Name and email.                       | –    |
| Customer: phone                                                 | `ticket.js:527`                                  | **Missing.** | Not shown.                            | S    |
| Tiles: orders, lifetime, last order                             | `ticket.js:528-531`                              | **Missing.** | Not there.                            | –    |
| The shop's tags on the customer                                 | `ticket.js:532`                                  | **Missing.** | The sync doesn't store customer tags. | S    |
| The shop's note on the customer                                 | `ticket.js:533`                                  | **Missing.** | The sync doesn't store it.            | S    |
| “New email” to this customer                                    | `ticket.js:538-539`                              | **Missing.** | Not there.                            | –    |
| Orders, with how many                                           | `ticket.js:541-543`                              | **Matched.** | The last five.                        | –    |
| Order card: name, date, total, Paid / Fulfilled / Cancelled     | `ticket.js:563-570`                              | **Partly.**  | Statuses as words in a line.          | –    |
| Items with the option's photo and quantity                      | `ticket.js:572-575`                              | **Partly.**  | Titles and quantities.                | –    |
| Tracking: status and a link to the carrier                      | `ticket.js:576-580`                              | **Missing.** | Not shown.                            | S    |
| Ship to, with the delivery method and address                   | `ticket.js:581-583`                              | **Missing.** | Not shown.                            | –    |
| The order's note                                                | `ticket.js:584`                                  | **Missing.** | Not shown.                            | –    |
| “Add to reply”: the order as plain text                         | `ticket.js:494-499,586`                          | **Missing.** | Not there.                            | –    |
| “Ship” / “Label”: open the order in Shipping                    | `ticket.js:587`                                  | **Missing.** | Not there.                            | –    |
| Open the order in the shop                                      | `ticket.js:588`                                  | **Missing.** | Not there.                            | –    |
| Earlier conversations, with a nudge to merge open ones          | `ticket.js:545-550`                              | **Partly.**  | A list.                               | –    |
| Activity: everything that happened, newest first, with a filter | `ticket.js:332-346`                              | **Missing.** | Nothing is logged.                    | S    |

### Numbers

| Capability                                                | Old app                                                     | New suite    | What's different or missing                                                             | Size |
| --------------------------------------------------------- | ----------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------- | ---- |
| Support numbers: volume, time to first reply, by teammate | `public/js/analytics.js:203-262`, `src/routes/analytics.ts` | **Partly.**  | `desk/reports/page.tsx` has the counts and reply times; no “when tickets arrive” chart. | S    |
| What AI has cost, by day and feature                      | `analytics.js:144-160`, `src/lib/usage.ts`                  | **Missing.** | The suite meters AI against the plan's allowance; there is no cost page.                | S    |

### Settings & automation

| Capability                                                                | Old app                                      | New suite    | What's different or missing                             | Size |
| ------------------------------------------------------------------------- | -------------------------------------------- | ------------ | ------------------------------------------------------- | ---- |
| Saved replies with placeholders                                           | `src/lib/macros.ts`, `public/js/settings.js` | **Matched.** | `lib/config.ts`, Settings → Help desk.                  | –    |
| Rules: on new mail, tag / set priority / assign                           | `src/lib/rules.ts`                           | **Matched.** | `lib/config.ts` (`actionsFor`), `apply_ticket_rules()`. | –    |
| Rules that run on a reply or a status change, and auto-reply with a macro | `src/lib/rules.ts:60-114`                    | **Missing.** | Rules run on new mail only and never send anything.     | M    |
| Hand out new tickets by turns or by load                                  | `src/lib/rules.ts`, `settings-support.js`    | **Missing.** | A rule can name one person.                             | S    |
| Signature, undo seconds, what happens after closing                       | `settings-support.js`                        | **Missing.** | None of the three.                                      | S    |
| Bring in older email as closed tickets                                    | `src/lib/gmail.ts` (import)                  | **Missing.** | Only mail that arrives from now on.                     | L    |
| “AI knowledge” entries that guide drafts                                  | `src/lib/kb.ts`, `src/lib/ai.ts`             | **Missing.** | Drafts use saved replies, orders and Stock.             | M    |

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

| Left out                                                           | Why                                                      | What it needs                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Live chat view and chat replies                                    | The suite has no website chat.                           | A chat widget, a public endpoint and a channel on tickets: a feature of its own. |
| Instagram & Facebook view                                          | The Social tool only posts.                              | Meta's messaging permissions (a new app review) and a webhook.                   |
| Discount codes                                                     | The shop connection can't write discounts.               | A new shop permission (`write_discounts`) and the owner's go-ahead.              |
| Archive, Spam, Trash                                               | The suite has open, in progress, closed and snooze.      | Three more states on `tickets` and their views.                                  |
| Pictures and files on incoming email                               | Only the words of an email are kept.                     | A private storage bucket, size limits and a redaction path.                      |
| HTML email as sent                                                 | A rule here: customer email is shown as plain text only. | A decision to change the rule, then a locked frame.                              |
| Customer tags, note and phone from the shop                        | The sync stores a customer's name and email only.        | Three columns and the sync asking for them (no new permission).                  |
| Tracking for parcels not sent through the suite                    | The sync doesn't store the shop's fulfilments.           | Reading fulfilments in the order sync.                                           |
| Bulk actions, CSV export, undo send, suggested replies, tag groups | Not built in this pass.                                  | Each is S–M with no new permission.                                              |

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

Customer photos can't be shown until incoming attachments are kept (see section 3).
