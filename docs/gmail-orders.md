# Emailing purchase orders from a business's own Gmail

Stock can email a purchase order to a supplier from the business's own Gmail, with the PDF attached. This page is for whoever runs the suite: what to set up in Google Cloud, what the two environment variables are, and what Google will ask for before businesses other than your own can use it.

For how a business uses it, see the help topic "Email an order to your supplier from your own Gmail".

## What it does, and what it can't do

- The connection is a provider like any other (`google_mail` in `src/lib/connections/providers/google-mail.ts`). The permission to send is kept in Supabase Vault and read only through `getProviderToken`.
- It asks Google for three things: `openid` and `email` (to show which mailbox is connected) and `https://www.googleapis.com/auth/gmail.send`. That last one can send mail as the person. It cannot read, search, change or delete anything in the mailbox. (A workspace can separately choose to add read-only access so Stock can read its suppliers' bills; that is off unless asked for, and is described in `docs/bills-by-email.md`.)
- Nothing is sent by a timer or by the assistant. A send happens only when an owner or admin has looked the email over and pressed the send button.
- Until the two environment variables below are set, the Gmail connection isn't shown at all and nothing else changes.

## Environment variables

| Name                        | What it is                                                     |
| --------------------------- | -------------------------------------------------------------- |
| `GOOGLE_MAIL_CLIENT_ID`     | The OAuth client's ID (ends in `.apps.googleusercontent.com`). |
| `GOOGLE_MAIL_CLIENT_SECRET` | The OAuth client's secret.                                     |

Set both on the `web` service (that is where connecting and sending happen) and on the `worker` (so it can renew the sign-in if it is ever the one to notice it has run out). They are listed in `.env.example`. Never commit them.

## Setting it up in Google Cloud

These are the steps as Google's console lays them out at the time of writing (late 2026). Google renames these pages from time to time; the names of the settings matter more than where they sit.

1. **A project.** In [Google Cloud Console](https://console.cloud.google.com/), create a project for the suite (or use one you already have for it).
2. **Switch the Gmail API on.** APIs & Services → Library → "Gmail API" → Enable. If this is skipped, sending fails with "Sending from Gmail isn't switched on for this app yet".
3. **The consent screen** (APIs & Services → OAuth consent screen, also called "Google Auth Platform"):
   - **Branding:** the app's name as people will see it on Google's screen, a support email, your home page, your privacy policy, and your domain under "Authorized domains".
   - **Audience:** see "Who can connect" below. Choose **Internal** or **External**.
   - **Data access (scopes):** add `openid`, `.../auth/userinfo.email` and `.../auth/gmail.send`. Add nothing else. Google lists `gmail.send` under "Sensitive scopes".
4. **The OAuth client.** APIs & Services → Credentials → Create credentials → OAuth client ID → type **Web application**.
   - Under **Authorized redirect URIs** add exactly: `https://<your site>/api/connections/google_mail/callback`
   - For local work, also add `http://localhost:3000/api/connections/google_mail/callback`.
   - Copy the client ID and secret into the two environment variables and redeploy.
5. **Try it.** In a workspace, open Connections. "Gmail (to email orders)" should now be listed. Connect it, open a purchase order under Stock → Orders, and send it to an address of your own first.

## Who can connect: testing, your own organisation, everyone

`gmail.send` is a **sensitive** scope. Google will not let just anyone grant it to an app it hasn't looked at. What that means depends on the "Audience" setting:

| Audience                                | Who can connect                                                                 | Catches                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Internal**                            | Only accounts in the Google Workspace organisation that owns the Cloud project. | No review by Google, no warning screen. Good for your own business on its own Workspace. Not possible with a personal @gmail.com account as the project's owner.    |
| **External, in testing**                | Only the accounts you list as "Test users" (100 at most).                       | Google shows "Google hasn't verified this app". **Permission lapses after 7 days**, so the mailbox has to be connected again each week. Fine for trying things out. |
| **External, in production, unverified** | Anyone, up to a cap of 100 people in total.                                     | The "Google hasn't verified this app" warning, which people must click through. Not something to put in front of customers.                                         |
| **External, in production, verified**   | Anyone.                                                                         | Needs Google's verification first (below).                                                                                                                          |

**Before other businesses can use it, the app must pass Google's OAuth verification for the `gmail.send` scope.** Expect to provide:

- a home page and a privacy policy on a domain you have verified in Google Search Console, with the privacy policy saying what the app does with Google data (here: sends the emails a person asks it to send, and stores nothing from the mailbox);
- a written reason for needing `gmail.send` ("the person sends purchase orders to their suppliers from their own address, on their own press of a button; the app never reads mail");
- a short screen recording showing the Google consent screen (with the client ID visible in the address bar) and the feature in use;
- the app's name and logo matching what is on your site.

Google's review of a sensitive scope usually takes days to a few weeks and may come back with questions. `gmail.send` is **not** one of Google's "restricted" scopes (those are the ones that read mail), so the yearly outside security assessment that restricted scopes need does not apply.

Until verification is done, the practical choices are: Internal, if your own business's Google Workspace owns the project; or External in testing with yourself as a test user, reconnecting weekly.

## What is stored

- In Vault, as the connection's token: Google's access token and refresh token. Read only by `getProviderToken`.
- On the connection row: the mailbox's address (`metadata.email`), so the page can say which mailbox is connected.
- On each order (`purchase_order_emails`): when it was emailed, who pressed, the addresses it went to, the subject, the mailbox it went from, Gmail's ids for the message and its conversation, and what the order said at the time (so a later change can be listed). The message's wording isn't stored: it is in the sender's own Sent folder. No token is ever stored there.

## When something goes wrong

| What the person sees                                    | What it means                                                                                        |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| "Gmail needs reconnecting"                              | Google no longer accepts the saved permission (taken back, lapsed in testing mode, password change). |
| "Sending from Gmail isn't switched on for this app yet" | The Gmail API is off in the Cloud project (step 2).                                                  |
| "Gmail wouldn't send it: …. Nothing was sent."          | Gmail turned the message down. Nothing went; the same button can be pressed again.                   |
| "We didn't hear back from Gmail…"                       | The answer never arrived, so the email may or may not have gone. It is never resent automatically.   |
| Gmail isn't listed under Connections                    | The two environment variables aren't set on the web service.                                         |

## Not verified in this build

This was built and tested against fakes, not a live Google project: the adapter, the message builder and the send-once flow all have tests, but nobody has yet connected a real mailbox through it. The first real connection should be watched from end to end (connect, send to yourself, check the PDF opens, edit the order, send again and see it land in the same conversation).
