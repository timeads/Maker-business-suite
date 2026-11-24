# Bills by email: supplier balances that fill themselves in

Stock → Balances can file a supplier's invoices, statements and payment notices by itself. This page is for whoever runs the suite: how it works, what has to be set up, what is kept, and what Google asks for before the optional "read my Gmail" route can be offered to businesses other than your own.

For how a business uses it, see the help topic "Have bills file themselves from email".

## Three ways in, one reader

| Way in                         | What the business does                                                                               | What it needs from us                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Forwarding** (the usual way) | Forwards supplier mail (a Gmail filter, any provider's forwarding, or by hand) to its bills address. | The inbound email already set up for the help desk. No permission from Google. |
| **Reading Gmail** (optional)   | Connects Gmail "with reading" and ticks "Read supplier emails from my Gmail once a day".             | The Gmail connection plus Google's read-only scope (below).                    |
| **Upload**                     | Presses "+ Upload an invoice or statement" on a supplier's balance page.                             | Nothing.                                                                       |

Whichever way a message arrives, it goes down one road (`src/lib/stock/mail/intake.ts`):

1. **Whose is it?** Held against the workspace's own list (`configs`: `stock` / `email_sources`): each supplier's sender address or domain, optional subject words, and for a bank's notices the words that show which supplier a payment was to. Nothing in the code knows a supplier by name.
2. **Read.** Claude reads the message and its PDFs or pictures into a fixed shape (`reader.ts`, `extract.ts`): kind, invoice number, dates, amount, currency, stated balance, and how sure it was of each. Structured output, no tools. The email goes in marked as material; the answer is checked field by field and anything that doesn't fit is dropped.
3. **Plan.** `plan.ts` (pure) turns the facts into entries and decides what is skipped or marked "to check".
4. **File.** `file_email_entries` (one SECURITY DEFINER function, service role, names the workspace) holds the entries against the account under a lock and writes them to `supplier_ledger` with `source = 'email'` (or `'upload'`), how it arrived (`mail_route`: `gmail` or `forward`) and Gmail's ids when it was read there.

## The rules (after TuftStock's importers)

- **The same message never files twice.** A message is known by a key made from its own `Message-ID` header, so a bill that is both forwarded and found in Gmail is one message. Each entry's `external_key` is built from that key plus the invoice number (or the payment's date and amount).
- **One row per invoice number.** An invoice whose number is already on the supplier's account, however it got there, is not added again ("#1007", "inv 1007" and "1007" are the same number). If a later emailed copy has a different amount, an emailed entry follows it and is marked to check; a typed-in entry keeps its figure and is marked to check.
- **The latest statement wins.** An invoice or payment dated on or before the supplier's newest statement is already in that statement's figure and is not filed; a statement older than the one on file is not filed. An invoice keeps the first date it was billed under.
- **Doubt is marked, never guessed.** A read the reader wasn't sure of, a total that doesn't match its lines, a printed date that doesn't fit the email, a changed amount, or a source set to "always check" is filed marked **to check**. As on TuftStock, such an entry **counts in the balance from the start**: the mark asks a person to look, it does not hold the entry back. A manager presses "Looks right", corrects it, or removes it.
- **What can't be read is skipped with a reason**, to be typed in: no total, no invoice number, an estimate, another currency. A statement's balance is only taken when the reader was sure of it, because a wrong statement would reset the whole account.
- **Removed stays removed** (`supplier_ledger_skips`): by the entry's own key, and for an invoice by its number too, so another copy in a later email stays off.
- **A payment is counted once.** The bank's notice and the supplier's "we received it" for the same money are counted once by the balance sums; a notice for a payment already typed in or read from the books (same amount within five days) is not filed.
- **A forwarded message nobody can place waits.** If no listed sender matches (the message's sender, the sender named in a hand-forwarded message, or the reader's "originally from"), what was read waits on the Balances page under "Whose is this?" for a manager to pick the supplier. Nothing is guessed.

## The bills address

- Formed like the help desk's address, on the same domain: **`bills-<token>@<INBOUND_EMAIL_DOMAIN>`**, where the token is 32 random hex characters (`stock_bills_addresses`). No new environment variable, inbound stream or DNS record is needed: if the help desk's inbound email works, this works. Where `INBOUND_EMAIL_DOMAIN` isn't set, the settings page says "Not available yet".
- The token is the only thing that says which workspace a message is for. Only owners and admins can read it; it is never logged. "Make a new address" replaces it, and the old address stops working at once. Mail to a token nobody has is dropped without a reply.
- Mail arrives through the same Postmark webhook and queue as the help desk's (`private.inbound_emails`), and the worker looks for a bills address among the recipients **before** the help desk sees the message, so it never becomes a ticket.
- **Gmail's confirmation.** When someone adds the address as a forwarding address in Gmail, Gmail emails it a code and a link. That message (known by its sender, `forwarding-noreply@google.com`) is never read as a bill: its code, and its link only if it points at `mail.google.com` or `mail-settings.google.com`, are shown to owners and admins on the settings page. The server never opens the link.
- **How long the queued copy is kept.** The queue is the help desk's and behaves the same: once a message has been dealt with, its payload (text and attachments) is replaced with `{}`; the row (an id and times) stays. A message that fails is retried up to eight times and its payload is kept meanwhile. For bills, the last failed try also clears it, so a bill's text and files are never left sitting in the queue. (A help desk message that fails all eight tries keeps its payload; nothing prunes it today.)

## Reading Gmail directly (optional)

The Gmail connection (`docs/gmail-orders.md`) asks only to send. Reading is an extra a person chooses while connecting ("Send orders, and read emails from the suppliers I list"), which adds one scope:

`https://www.googleapis.com/auth/gmail.readonly`

- What Google granted is recorded in the connection's `scopes`. Every read checks it, in the worker and again in the database (`private.email_reading_on`): a connection that can only send never has its mail looked at. Connecting again with "Send purchase orders only" takes the permission back.
- The worker looks once a day per workspace, at or after the hour the workspace chose on its own clock (`claim_stock_email_reads`), or on a manager's "Read now" (ten minutes apart, six a day). A look that never finishes is marked failed, not run again.
- Only searches built from the workspace's own sources are ever sent to Gmail (`query.ts`): each names a sender and a time window (`from:(…) newer_than:10d`; 45 days on the first look), plus the source's label and subject words. Each message found is checked again for its sender, so the business's own replies in the same conversation are not read. A bank notice that isn't about a listed supplier is never handed to the reader.
- Three Gmail calls are used: search, get a message, get an attachment. Nothing in the mailbox is changed.

### What to add in Google Cloud

In the Cloud project that already holds the Gmail OAuth client:

1. APIs & Services → OAuth consent screen (Google Auth Platform) → **Data access** → Add or remove scopes → add `https://www.googleapis.com/auth/gmail.readonly`. Google lists it under **Restricted scopes**.
2. Nothing changes on the OAuth client or the redirect URI. No new environment variable.
3. Connect Gmail again in the workspace, choosing reading (Stock → Balances → Bills by email has a button for it).

### Who can use it

`gmail.readonly` is a **restricted** scope, a stricter class than the sensitive `gmail.send`:

- **Internal** audience (the Cloud project belongs to your own Google Workspace organisation): your own accounts can grant it with no review. This is how your own business can use it today.
- **External, in testing:** only listed test users, and the permission lapses after seven days.
- **External, in production:** before other businesses can grant it, the app must pass Google's verification for restricted scopes. Beyond what a sensitive scope needs (verified domain, privacy policy, a written justification, a demo video showing the consent screen and the feature), Google requires that the use fits one of its permitted application types for Gmail data and its Limited Use rules, and that the app passes a **security assessment by a Google-approved independent assessor**, which has to be renewed every year for as long as the scope is used. Google also asks that no narrower scope would do; here the answer is that reading attachments needs message content, and that forwarding is offered for everyone who doesn't want to grant it.

That is why **forwarding is the standard route** for other businesses and reading Gmail is the optional extra.

## What is kept, and what isn't

- **Never kept:** a message's text, its attachments, an uploaded file. They are in memory while being read and are then gone (and cleared from the inbound queue, above).
- `stock_email_messages`: for each message looked at, its key, how it came, Gmail's message and thread ids (when read there), when it was sent, the sender's address, the subject, the supplier, how it ended, and the reasons anything was left out. Kept 400 days.
- `supplier_ledger`: the entries themselves, with `source`, `mail_route`, Gmail's ids (for a plain "Open the email in Gmail" link; nothing is fetched), `needs_review` and `review_note`.
- `stock_email_pending`: for a message nobody could place, the facts read from it (not its text), until a manager assigns or discards it.
- `stock_email_reads`: one row per look, forwarded message or upload: when, counts (seen, read, filed, to check), what was skipped and why. Kept 60 days.
- `stock_bills_addresses`: the token, when mail last arrived, and Gmail's confirmation code and link while one is waiting.

All four tables and the ledger are readable only by the workspace's owners and admins.

## Limits

| Limit                                    | Value                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| Messages read per workspace per 24 hours | 120, by every road in                                                  |
| Messages read in one look at Gmail       | 40                                                                     |
| Messages found per source per look       | 25 (one page; the rest wait for the next look)                         |
| Attached files read per message          | 3                                                                      |
| Size of one file                         | 5 MB                                                                   |
| Kinds of file                            | PDF, PNG, JPEG (checked by their first bytes, not only their name)     |
| Message text handed to the reader        | 20,000 characters                                                      |
| Documents one message can yield          | 12                                                                     |
| "Try it"                                 | 3 messages, files nothing                                              |
| "Read now"                               | once per ten minutes, six a day                                        |
| Claude                                   | counted against the plan's monthly AI allowance; reading stops at zero |

When a limit is hit, the run's record says so ("stopped at a limit"), and what was over is listed under "Left out of recent reads".

## Environment

Nothing new. It uses what is already there:

- `INBOUND_EMAIL_DOMAIN` and `POSTMARK_INBOUND_SECRET` (the help desk's inbound email) for forwarding.
- `GOOGLE_MAIL_CLIENT_ID` / `GOOGLE_MAIL_CLIENT_SECRET` for reading Gmail.
- `ANTHROPIC_API_KEY`: **must be set on the `worker` service as well as `web`**, because the worker is now where forwarded mail and Gmail looks are read. Uploads and "Try it" are read on `web`.

## How TuftStock's supplier-specific rules map onto settings

| TuftStock (written in code for one supplier or one bank)                                   | Here                                                                                                                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| A Gmail search per supplier (`from:<domain> filename:pdf`), sender checked per message     | A supplier source: `from`, optional `label` and `subject_words`, `reads`. The sender is re-checked on every message.            |
| File-name patterns that mean "this is an invoice", and words that mean it isn't            | `skip_file_words` on the source; beyond that the reader says what each document is, and estimates and other papers are skipped. |
| The invoice number taken from the file name or the subject                                 | The reader takes the number printed on the invoice, else from the subject or file name.                                         |
| One supplier's scans read by OCR first, and every such read marked for review              | No separate step (the reader reads scans); `always_check` on the source marks everything from it.                               |
| Statement emails recognised by subject words; balance and payments read from the text      | A source of kind `statement` (or `mixed`) with `subject_words`; the reader reports the balance and the payments listed.         |
| Bank wire notices from one sender, kept only when sent to an account ending in four digits | A bank source: `from`, `subject_words`, and per supplier the `words` a notice carries (the account's ending, or a name).        |
| "Payments stopped arriving" for the suppliers paid by a route with no email trail          | `quiet_days` against a supplier in the bank source: a notice when money is owed and no payment has been filed for that long.    |
| Dates taken in the supplier's own time zone                                                | **Not carried over.** An invoice is dated by the date printed on it, else by the workspace's own day the email was sent.        |
| Two invoices sharing one number, told apart by a word in the file name                     | **Not carried over.** They read as one invoice whose amount changed, which is marked to check for a person to sort out.         |
| A Drive folder to drop PDFs into                                                           | **Not built.** The upload button does the same job with no Drive permission. A folder would be a later step.                    |
| A daily run that looks back ten days; a one-off 45-day catch-up; a dry run                 | The same windows; "Try it" is the dry run, and the first look is the catch-up.                                                  |

## Not verified in this build

Built and tested against fakes. Not yet tried against: a live Google project with the read scope, a real mailbox's search results, Postmark's real inbound payload for a forwarded message with attachments, Gmail's real forwarding-confirmation email (its sender and the shape of its link are taken from how Gmail has sent it for years, not from a message received here), or the real model on real invoices, scans and statements. The first real use should be watched end to end with "Try it" before reading is switched on, and the first few filed entries compared against their emails.
