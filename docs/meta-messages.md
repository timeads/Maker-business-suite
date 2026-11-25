# Instagram and Facebook messages in the help desk

Messages people send a business's Instagram account or Facebook Page can
arrive in the help desk as conversations and be answered from the same reply
box as email. This page says how it works, what the person who runs the suite
has to set up at Meta, and what is and isn't stored.

Checked against Meta's developer documentation on 25 November 2026 (Graph API
v27.0 was current; the suite calls `META_API_VERSION`, v23.0 by default, which
Meta lists as available until October 2027). Nothing here has been run against
Meta's real API: see "Not checked against the real thing" at the end.

## How it works

- **One connection.** Messages ride on the same Facebook & Instagram connection
  Social posts with: Facebook Login, a Page, and the Instagram professional
  account linked to that Page. Messaging needs extra permissions, and they are
  **optional**: a workspace is only asked for them when an owner or admin
  presses "Allow messages on Facebook" under Settings → Help desk → Channels.
  A workspace that only posts is never asked and nothing about it changes.
- **What Facebook granted is what counts.** After that login the suite asks
  Meta which permissions were really granted and records only those in the
  connection's `scopes`. A channel works only when its permissions are there,
  the connection is live, and the channel is switched on (`helpdesk` /
  `channels` in `configs`).
- **In.** Meta posts to `/api/webhooks/meta`. The web service checks the
  `X-Hub-Signature-256` signature on the raw body with the app secret, queues
  the delivery (`private.meta_events`) and answers at once. A delivery for a
  Page or Instagram account that no workspace has connected for messages is
  dropped unread. The worker files each message: one conversation per person
  per channel, reopened when they write again, with the workspace's auto-tag
  rules applied as for email. The same message twice (Meta retries) is filed
  once, by Meta's message id.
- **Files.** Photos, videos and voice messages are downloaded by the worker,
  because Meta's links stop working, and only from Meta's own file hosts
  (`*.fbcdn.net`, `*.fbsbx.com`, `*.cdninstagram.com`, over https; a redirect
  to anywhere else is refused). They are then kept under the help desk's usual
  rules: by what their own first bytes say they are, 25 MB a file. Shared
  posts, story replies, story mentions and view-once photos are noted in words
  ("Shared a post") and not downloaded.
- **Out.** A reply is plain words and, optionally, up to three JPEG or PNG
  pictures. It goes through the help desk's outbox like an email, so "Undo"
  works the same way, and is sent with Meta's Send API. Pictures are handed to
  Meta as a link to our private storage that works for ten minutes and is
  removed straight after.
- **The 24-hour window.** Meta lets a business reply for 24 hours after the
  customer's last message. The reply box works this out from the conversation,
  says until when a reply can go, and refuses to send after that (an internal
  note still works). The server checks again before queuing and the worker
  again before sending.
- **Human Agent (off).** Meta has a "Human Agent" feature that stretches the
  window to seven days for a person's reply. It needs its own approval in App
  Review and business verification. The suite has a switch for it (Channels →
  "For apps approved for Meta's Human Agent feature") that is off by default.
  Leave it off unless the app has that approval: without it Meta refuses those
  replies.
- **Replies made in the Instagram or Facebook app** come back as "echoes" and
  are filed as the team's, marked "sent from the Instagram app". What the help
  desk itself sent is not filed twice.
- **Reactions** show as a small line in the conversation and never reopen it.
  A message the customer **unsends** is marked as removed: its words and files
  are deleted here too.

## What the person who runs the suite does at Meta

All of this is in the Meta app the suite already uses for Social
(developers.facebook.com → My Apps → the app).

1. **Add the products.** In the app dashboard add the **Messenger** product
   (use case "Engage with customers on Messenger from Meta"), and under it the
   **Instagram** settings ("Instagram Messaging" via the Messenger Platform,
   for Instagram accounts linked to a Facebook Page). The app must keep
   **Facebook Login for Business**, which Social already uses.
2. **Webhooks.** Under Messenger → Settings → Webhooks (and the same under
   Instagram settings) enter:
   - Callback URL: `https://<your site>/api/webhooks/meta`
   - Verify token: the value you put in `META_WEBHOOK_VERIFY_TOKEN`
     Meta calls the address once to check it; the web service must already be
     running with that variable set. Then subscribe to these fields:
   - **Page** object: `messages`, `message_echoes`, `message_reactions`
   - **Instagram** object: `messages`, `message_reactions`
     (On Instagram, replies sent from the app arrive on `messages`; there is no
     separate echoes field.) Other fields are ignored if they arrive.
3. **Permissions.** The login now asks, only for workspaces that switch
   messages on, for: `pages_messaging`, `pages_manage_metadata`,
   `instagram_manage_messages` and `business_management` (Meta lists the last
   as a dependency of the others), on top of what Social already asks for
   (`pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
   `instagram_basic`, `instagram_content_publish`). Add them to the app's
   permissions (Use cases → Customize, or App Review → Permissions and
   features).
4. **Data deletion.** Under App settings → Basic → "Data deletion request",
   choose "Data deletion callback URL" and enter
   `https://<your site>/api/webhooks/meta/deletion`. See "Deleting someone's
   data" below.
5. **The app must be published** ("Live") to receive webhooks at all, whatever
   the state of App Review.
6. **On Instagram itself**, each business must allow connected tools to read
   messages: Instagram app → Settings → Messages and story replies → Message
   controls → Connected tools → Allow access to messages. Without it Instagram
   sends nothing.

### What works before App Review, and what review needs

- **Before review (Standard Access).** The app works for Pages and Instagram
  accounts managed by people who have a role on the app (admin, developer,
  tester), and only for messages from people who also have a role on the app.
  Meta's Send API refuses to message anyone else ("Cannot message users who
  are not admins, developers or testers of the app until pages_messaging
  permission is reviewed and the app is live"). So to try it: add a second
  personal account as a tester on the app and message the Page or Instagram
  account from it.
- **For real customers, and for other businesses (Advanced Access).** Each of
  `pages_messaging`, `pages_manage_metadata`, `instagram_manage_messages`,
  `instagram_basic` (and `business_management`) needs Advanced Access through
  **App Review**, and the business that owns the app needs **Business
  Verification**. Meta asks for a screen recording showing how someone logs in
  to the suite, grants the permissions with Facebook Login, receives a
  message, replies to it, and how an unsent message is handled; written
  step-by-step instructions; and test credentials for a workspace. Meta's page
  for inbox tools used by other businesses is "App Review → Apps for other
  businesses" in the Instagram Messaging docs.
- **Names on Facebook.** Reading a Messenger customer's name needs the
  "Business Asset User Profile Access" feature (also App Review). Without it
  Facebook conversations show as "Facebook user". Instagram names and @handles
  come with the messaging permissions.
- **Human Agent** is a separate feature request in App Review, with business
  verification. Not needed for the 24-hour window.

## Environment variables

| Variable                    | Where       | What                                                                                  |
| --------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| `META_APP_ID`               | web, worker | Already set for Social. The worker uses it to tell its own sends from the app's.      |
| `META_APP_SECRET`           | web, worker | Already set for Social. Checks webhook signatures and deletion requests.              |
| `META_WEBHOOK_VERIFY_TOKEN` | web         | New. A long random string you choose; the same one goes in Meta's "Verify token" box. |
| `META_API_VERSION`          | web, worker | Optional, as before.                                                                  |

Nothing else is new. `SUPABASE_SECRET_KEY` and the storage bucket are the ones
the help desk already uses. The migration is
`supabase/migrations/20270110000100_helpdesk_social.sql`.

## Switching it on in a workspace

1. Settings → Help desk → Channels → **Allow messages on Facebook** (or
   "Connect Facebook & Instagram" if nothing is connected). Facebook asks for
   the extra permissions; leave them all ticked and pick the same Page.
2. Back on Channels, tick **Instagram messages** and/or **Facebook messages**
   and save. The suite asks Meta to send that Page's messages to the webhook.
3. Send a test from an account that has a role on the app (until review is
   done). It appears under **Instagram & Facebook** in the help desk's menu
   within a minute.

Reconnecting from the Connections page later keeps the messaging permissions:
the suite asks for them again by itself if they were granted before.
Unticking both channels asks Meta to stop sending; disconnecting Facebook &
Instagram under Connections removes the permission altogether (and stops
posting).

## What is stored about a person

- Their id as Meta scopes it to the Page or Instagram account, their name and,
  on Instagram, their @handle (read from Meta, re-read at most once a month).
  **No profile picture** is fetched or shown; the handle is a plain link.
- What they wrote, when, and our own few words for anything that isn't text.
- Files they sent that are a kind the help desk keeps, in the private
  `helpdesk` bucket, served only through the help desk's file route.
- An email address **only if the team writes one down** for them ("Add their
  email" in the details rail). That is the only way their shop orders are
  shown: a customer is never matched by name.
- Not stored: Meta's links to files, story or post content, follower counts,
  read receipts, or the delivery's raw payload once it has been filed.

## Deleting someone's data

- **In the help desk:** an owner or admin opens a conversation → Details →
  "Forget this customer". The person, every conversation with them, what was
  said and their files are deleted. The audit log notes that it happened and
  on which channel, not who.
- **A shop's privacy request** for an email address also forgets anyone on
  Instagram or Facebook the team had written that email down for.
- **Meta's data deletion callback** (`/api/webhooks/meta/deletion`): Meta posts
  a signed request naming an id; the signature is checked with the app secret,
  the request is queued, and the worker deletes whatever is held under that id
  in any workspace. Meta gets back a confirmation code and a link the person
  can open to see whether it is done. To be plain about its reach: Meta
  documents the id in that request as an **app-scoped user id**, the id of
  someone who logged in to the app with Facebook (in the suite, a workspace
  owner who connected a Page). The people who message a business are known to
  us by Page-scoped or Instagram-scoped ids, which are different numbers. So
  this callback will usually find nothing to delete; a customer's own request
  is carried out with "Forget this customer". The suite's privacy policy
  should say how to ask.

## Not checked against the real thing

Built from Meta's documentation and the owner's working help desk, with every
call to Meta faked in tests. Not yet seen working against Meta:

- That a Page subscribed with `messages` also delivers its linked Instagram
  account's messages once the app's Instagram webhook is set (Meta's docs say
  the Instagram object is subscribed on the app and the Page is "installed"
  with `subscribed_apps`; the owner's app does the same).
- That `entry.id` on Instagram deliveries is the same id the connection stores
  as the Page's `instagram_business_account.id`. If it isn't, deliveries are
  dropped as "not connected" and the worker log will show nothing filed.
- The exact hosts Meta serves message files from. The list is the three Meta
  uses for media today; a file from any other host is listed as "a file we
  didn't keep".
- Whether Instagram echoes carry an `app_id`. If they don't, the help desk's
  own sends are still not filed twice (they are matched by message id).
- Messenger's limit of 2,000 characters for a text message: it is the long
  documented figure, but the reference page for it could not be read on the
  day. Instagram's 1,000 bytes was confirmed.
- How long Meta's file links last. Meta only says they expire.
- Sending a picture by a signed link to our storage, and the Human Agent tag.
