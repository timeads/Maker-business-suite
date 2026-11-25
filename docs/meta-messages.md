# Instagram and Facebook messages and comments in the help desk

Messages people send a business's Instagram account or Facebook Page, and
comments they leave on its posts, can arrive in the help desk as conversations
and be answered from the same reply box as email. This page says how it works,
what the person who runs the suite has to set up at Meta, and what is and
isn't stored.

Checked against Meta's developer documentation on 25 November 2026 (Graph API
v27.0 was current; the suite calls `META_API_VERSION`, v23.0 by default, which
Meta lists as available until October 2027). Nothing here has been run against
Meta's real API: see "Not checked against the real thing" at the end.

## Which Meta use cases the app needs, for which feature

Meta's app dashboard hands out permissions by **use case**. A use case can't
be removed once added, more than one can sit on an app, and each has
permissions that come with it and optional ones you add under **Use cases →
Customize**. Facebook Login refuses a whole login ("Invalid Scopes") when it
is asked for a permission the app doesn't carry, so **the suite asks only for
the permissions of the feature a workspace is switching on**, plus whatever
that workspace's connection was already granted
(`src/lib/connections/meta-access.ts`). An app that only has the Messenger use
case therefore works for a help-desk-only workspace; it just can't offer
posting or comments until the other use cases are added.

The names below are Meta's, as listed in "Create an app → Available use cases"
and its "Use Case Permission Mapping" table on the day of checking.

| Feature in the suite                   | Use case to add in the Meta app                                                    | Permissions the login asks for                                                                                                                                | In that use case                                                                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Messages** (help desk)            | **Engage with customers on Messenger from Meta**                                   | `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `business_management`, `instagram_basic`, `instagram_manage_messages`, `pages_read_engagement` | The first four come with the use case and can't be removed. **Add the last three under Customize** (Meta lists each as "Optional for this use case"). Without them: "Invalid Scopes". |
| **2a. Facebook comments** (help desk)  | **Manage everything on your Page**                                                 | `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`                                     | `pages_show_list` comes with it and `pages_manage_engagement` is added by default; add `pages_manage_metadata`, `pages_read_engagement` and `pages_read_user_content`.                |
| **2b. Instagram comments** (help desk) | **Manage messaging & content on Instagram**, with "API setup with Facebook Login"  | `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`, `instagram_basic`, `instagram_manage_comments`                                           | Add `instagram_manage_comments` (and `instagram_basic`, `pages_read_engagement`, `pages_show_list` if not already there). `pages_manage_metadata` comes from use case 1 or 2a.        |
| **3. Posting** (Social)                | **Manage everything on your Page** and **Manage messaging & content on Instagram** | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`                                              | Add `pages_manage_posts` to the Page use case. In the Instagram use case press "Add all required permissions" for content (Meta's page calls it `instagram_content_publishing`).      |
| A **private message about a comment**  | (uses 1 and 2a or 2b together)                                                     | nothing more: `pages_messaging`, plus `instagram_manage_messages` on Instagram                                                                                | Offered only where messages were allowed as well as comments.                                                                                                                         |

Notes:

- The Instagram use case offers two setups and an app can have only one. The
  suite uses **Facebook Login** (the Instagram account is the one linked to the
  Page), so choose "API setup with Facebook Login", not "Instagram Login".
- Meta's table doesn't say, row by row, which optional permissions are ticked
  by default in every use case, and the dashboard changes. If Facebook answers
  "Invalid Scopes" when a workspace presses a button on the Channels screen,
  compare the "Permissions the login asks for" column above with what the use
  case shows under Customize: one is missing.
- Each permission still needs **Advanced Access through App Review** before
  workspaces whose owners have no role on the app can use it (see below).
- Before the app can be switched to **Live**, App settings → Basic needs a
  **Privacy Policy URL** (`https://<your site>/privacy`), a **Terms of Service
  URL** (`https://<your site>/terms`) and the data deletion callback (step 4
  below).

## How it works

- **One connection, several uses.** Messages and comments ride on the same
  Facebook & Instagram connection Social posts with: Facebook Login, a Page,
  and the Instagram professional account linked to that Page. Each use
  (posting, messages, Facebook comments, Instagram comments) has its own
  permissions and each is **optional**: a workspace is only asked for one when
  an owner or admin presses its button (Settings → Help desk → Channels for
  messages and comments; Connections or Social for posting). A login asks for
  that use plus what the connection already had, never more, so a workspace
  that only posts is never asked for messages, and one that only uses the
  help desk is never asked for posting.
- **What Facebook granted is what counts.** After every login the suite asks
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

## Comments on posts

- **What comes in.** A comment on one of the business's own posts: on a
  Facebook Page post (the Page's `feed` webhook field, `item: "comment"`), or
  on an Instagram post or reel (the Instagram `comments` field). Comments on
  boosted posts and ads arrive the same way. Not brought in: the Page's other
  feed activity (visitor posts, reactions, shares), comments during an
  Instagram live broadcast (`live_comments`), and mentions of the account on
  other people's posts (`mentions`); those are ignored if they arrive.
- **Threading.** One conversation per person per post, as in the owner's
  help desk: their first comment starts it ("Instagram comment: …"), their
  later comments and replies on that post land on it and reopen it, another
  post or another person starts another. A comment is filed once, by Meta's
  comment id, however often Meta delivers it. Comments and messages are never
  mixed or joined: the same person's messages are their own conversation.
  The two share the contact, so each lists the other under "Earlier
  conversations".
- **Which comments start a conversation** is the workspace's choice
  (Channels → "Which comments start a conversation"): comments worth answering
  (the default: not emoji-only, a tagged friend, or a one-word cheer like
  "love it"), only questions and the workspace's own words, or every comment.
  On a conversation that is already going, everything that person writes on
  that post is kept. The auto-tag rules apply as for email.
- **The post.** The first time a post is seen, the worker asks Meta once for
  its address and caption (`permalink_url,message` on Facebook,
  `permalink,caption` on Instagram) and keeps the address, only if it is on
  facebook.com or instagram.com, and the first 280 characters of the caption
  as plain text. **No picture or video of the post is fetched or stored.**
- **Who wrote it.** Facebook delivers the commenter's name and Page-scoped id;
  Instagram their username and Instagram-scoped id. These are the same ids
  messages use, so a person who comments and messages is one contact.
- **Edits, removals, hiding.** Facebook says when a comment is edited (the
  words change and it is marked "Edited"), removed (its words and files are
  deleted here and it reads "removed from the post") and hidden or shown
  again. **Instagram's webhook only reports new comments**: a comment deleted
  or hidden in the Instagram app is not reported, and stays here as it was.
- **The business's own comments.** A reply the team writes in the Facebook or
  Instagram app arrives through the same webhook and is filed as the team's
  ("sent from the Instagram app") under the comment it answers. A reply sent
  from the help desk is recognised by its comment id and never filed twice.
  The account's own comments that answer nobody are ignored.
- **A picture on a Facebook comment** is fetched from Meta's own file hosts
  only and kept under the help desk's usual rules, like a picture in a message.
- **Answering.** Two ways, chosen in the reply box:
  - **Reply publicly**: a comment under theirs (`POST /{comment-id}/comments`
    on Facebook, `POST /{comment-id}/replies` on Instagram), under the
    customer's latest comment that still stands. The reply box and its buttons
    say it is public. Plain words; no pictures. Instagram doesn't allow a reply
    to a hidden comment, and the box says so.
  - **Message privately**: Meta's "private reply", the Send API with the
    comment as the recipient (`recipient: {comment_id}`). Meta allows **one**
    per comment, **within seven days** of the comment. The database holds
    that rule (a claim on the comment taken before Meta is asked, given back
    only if Meta refuses), and the reply box shows why the choice is gone
    once it is used, expired, or the connection has no messaging permission.
    If the person answers, Meta's normal 24-hour window opens and their answer
    arrives as their ordinary message conversation.
    Both go through the help desk's outbox, so "Undo" works. A refusal from
    Meta keeps the words to put back; no clear answer is never sent twice.
- **Hide, show again, delete.** Under each comment. Hiding (the whole team)
  and deleting (owners and admins, after "are you sure") ask Meta first and
  are only marked here once Meta says yes.
- **Limits.** A public reply is capped here at 2,200 characters on Instagram
  and 8,000 on Facebook; a private message at what one message holds (1,000
  bytes on Instagram, 2,000 characters on Messenger). Meta's rate limit for
  private replies is 750 an hour per account; Page calls otherwise follow
  Meta's usual limits (4,800 calls a day per engaged user). The suite makes
  one call per reply and one per new post.

## What the person who runs the suite does at Meta

All of this is in the suite's Meta app (developers.facebook.com → My Apps →
the app).

1. **Add the use cases** for the features you want to offer, and their
   permissions: see the table at the top of this page. The app must keep
   **Facebook Login for Business**.
2. **Webhooks.** In each use case's settings ("Configure webhooks") enter:
   - Callback URL: `https://<your site>/api/webhooks/meta`
   - Verify token: the value you put in `META_WEBHOOK_VERIFY_TOKEN`
     Meta calls the address once to check it; the web service must already be
     running with that variable set. Then subscribe to these fields:
   - **Page** object: `messages`, `message_echoes`, `message_reactions` for
     messages; **`feed`** for Facebook comments
   - **Instagram** object: `messages`, `message_reactions` for messages;
     **`comments`** for Instagram comments. Leave `live_comments` and
     `mentions` unticked (they are ignored).
     (On Instagram, replies sent from the app arrive on `messages`; there is no
     separate echoes field.) Other fields are ignored if they arrive. The suite
     itself asks each connected Page to send the fields its workspace has
     switched on (`subscribed_apps`); the app-level list here is what Meta is
     willing to send at all.
3. **Permissions.** As in the table at the top: only what the features you
   offer need. Nothing is asked of a workspace until it presses the button
   for that feature.
4. **Data deletion.** Under App settings → Basic → "Data deletion request",
   choose "Data deletion callback URL" and enter
   `https://<your site>/api/webhooks/meta/deletion`. See "Deleting someone's
   data" below.
5. **The app must be published** ("Live") to receive webhooks at all, whatever
   the state of App Review.
6. **On Instagram itself**, each business must allow connected tools to read
   messages: Instagram app → Settings → Messages and story replies → Message
   requests → Allow access to messages. Without it Instagram
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
- **Comments need Advanced Access to arrive at all for other businesses.**
  Meta's Instagram webhook setup says "Advanced Access is required for
  comments and live_comments notifications", and that the account that owns
  the media must be public. With Standard Access, comments and private
  replies work only between people who have a role on the app. For review of
  `pages_manage_engagement`, `pages_read_user_content` and
  `instagram_manage_comments`, Meta asks for a screen recording of the login
  with the permission being granted, a comment arriving, a public reply, a
  hide and a delete, with written steps and test credentials.
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
   the messaging permissions only; leave them all ticked and pick the Page.
2. Back on Channels, tick **Instagram messages** and/or **Facebook messages**
   and save. The suite asks Meta to send that Page's messages to the webhook.
3. For comments: under **Comments on your posts** press **Allow Instagram
   comments** and/or **Allow Facebook comments** (each is its own trip to
   Facebook, asking for that platform's comment permissions on top of what the
   connection has), then tick them, choose which comments start a
   conversation, and save.
4. Send a test from an account that has a role on the app (until review is
   done). It appears under **Instagram & Facebook** in the help desk's menu
   within a minute.
5. For posting: a workspace that connected for the help desk first sees
   **Reconnect to allow posting** on the Social page, with an "Allow posting on
   Facebook" button. One that connects from the Connections page is asked for
   posting, as before.

Reconnecting from the Connections page later keeps what the connection had:
the suite asks again for exactly the uses that were granted before, and
nothing new. Unticking everything asks Meta to stop sending; disconnecting
Facebook & Instagram under Connections removes the permission altogether (and
stops posting).

## What is stored about a person

- Their id as Meta scopes it to the Page or Instagram account, their name and,
  on Instagram, their @handle (read from Meta, re-read at most once a month).
  **No profile picture** is fetched or shown; the handle is a plain link.
- What they wrote, when, and our own few words for anything that isn't text.
  For a comment: its words, Meta's id for it, whether it was edited or hidden,
  and, about the post, only its address and the start of its caption.
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
- Comments, end to end: that the Page's `feed` subscription also brings the
  linked Instagram account's `comments` (the owner's working help desk relies
  on the same arrangement), that `from.id` on a comment is the same
  Page-scoped or Instagram-scoped id messages carry, and how the account's
  own comments are marked on Instagram (the suite goes by `from.id` being the
  account's id, or `from.username` being its username).
- Which name Instagram gives the comment's id in the webhook: Meta's field
  reference says `id`, its Facebook Login example says `comment_id`. The suite
  reads either.
- That Instagram sends nothing when a comment is deleted or hidden in the app.
  The reference lists no such event; if one exists it is ignored today.
- The length Meta allows for a comment. Its reference pages give no figure;
  2,200 (Instagram) and 8,000 (Facebook) are our own caps.
- Hiding and deleting through the Page's token, and Meta's exact refusal when
  a comment has already had its private reply (the suite recognises the
  sentence, and otherwise shows Meta's own words).
- Which optional permissions each use case really offers in the owner's app
  dashboard. The table at the top is Meta's documentation on the day; the
  dashboard is the authority.
