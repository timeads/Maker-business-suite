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

## Several Pages and Instagram accounts

One Facebook login can hold several Pages, each with the Instagram
professional account linked to it, and a workspace can use several of them,
each as one of its brands.

- **What the login shares is offered, not used.** After Facebook's login the
  suite asks for every Page the person shared (`/me/accounts`, with each
  Page's `tasks`) and keeps each Page's own token in Vault beside the first
  one's (`token.secrets`, `page:<id>`); tokens are read only through
  `getMetaPageToken`, which goes through `getProviderToken`. Each Page and its
  Instagram account become rows in `social_accounts` (`note_meta_accounts`),
  unused until an owner or admin ticks them under **Settings → Social & emails
  → Social accounts** and picks the brand each belongs to
  (`choose_social_accounts`). A first login starts using its first Page with
  an Instagram account, as a login always did. Adding or removing an account
  never touches the others; an account no longer shared can't be used, and its
  rows (and what points at them) stay. One workspace at a time uses an account.
- **Per-Page permission.** Meta grants permissions to the login, but says per
  Page what the person may do there (`tasks`: `MANAGE`, `CREATE_CONTENT`,
  `MESSAGING`, `MODERATE`, ...). An account posts only where its Page allows
  `CREATE_CONTENT`, answers messages only with `MESSAGING` and takes comments
  only with `MODERATE` (`MANAGE` allows all). Where Meta didn't say (accounts
  from before this change), the login's permissions alone decide.
  (`accountAllows` in `meta-access.ts`; `private.meta_tasks_allow` is the
  database's twin.)
- **Routing.** A delivery is routed by the platform id on its webhook entry
  (a Page id, or an Instagram account id) to the workspace and the account
  (`resolve_meta_account`); anything no workspace uses is still dropped
  unread. The worker files through `file_account_message` /
  `file_account_comment`, so each conversation, person and post carries its
  account (`social_account_id`).
- **One conversation per person per account.** Meta gives a person a
  different id on each Page and each Instagram account, so the same human
  writing to two accounts is two people here, each with a conversation.
- **Answering as that account.** Replies, private replies, hiding and
  deleting, taking or asking for thread control, and the automatic first
  reply all go through the Page of the account the customer wrote to, with
  that Page's token. In an automatic reply `{{business_name}}` is the brand's
  name when the account belongs to a brand other than the main one (still
  fixed words filled in by code).
- **Webhook subscriptions.** Every Page with an account in use is asked to
  send its messages and comments (`subscribed_apps`, with its own token) when
  the Channels screen or the Social accounts screen is saved; a Page with
  none in use is asked to stop.
- **The inbox** names the account a conversation came to where a workspace
  has more than one of that kind, and can be narrowed to one account
  (`account` in the address).
- **More Pages later.** Social accounts → "Share more Pages with us" runs the
  login again, asking for what the connection already has. In Facebook's
  dialog, choose "Edit settings" (or "Edit previous settings") and tick the
  extra Pages; Facebook may otherwise reuse the earlier choice. (From memory
  of Meta's dialog; check it against the screen.)

## Using this alongside another inbox tool

Meta lets **one app at a time** answer a conversation. It calls this _thread
control_, and the rules _Conversation Routing_ (the older "Handover Protocol"
is retired: "Meta no longer supports the Handover Protocol for Instagram. All
businesses have been migrated to Conversation Routing"). It matters as soon as
a business's Page or Instagram account is connected to this suite **and** to
anything else that answers messages: another help desk, a chatbot, or Meta
Business Suite's own inbox, which Meta counts as a connected app (app id
`263902037430900` for the Page inbox, `1217981644879628` for the Instagram
inbox).

What Meta's pages say (read on 25 November 2026: "Conversation Routing for
Instagram", its "Conversation Control APIs" page, Messenger's "Conversation
Routing", the `standby` and `messaging_handovers` webhook references, and the
Messenger Platform error codes):

- **The thread owner** is the app allowed to answer a conversation. A
  conversation is _active_ while a customer has written in the last 24 hours
  and _idle_ otherwise, or once its owner releases it. Control lapses after 24
  hours of inactivity (an owner can extend it to 7 days; a conversation that
  starts from a click-to-message ad can be held for up to 30).
- **With a default app set** (this is what switches Conversation Routing on),
  only the thread owner can send while a conversation is active, and "only the
  default app can send messages" while it is idle. An app that is neither gets
  the customer's messages on the **`standby`** webhook channel instead of
  `messaging`, and its sends are refused: on Instagram `(#100)`, subcode
  `2534037`, "The action is invalid because your app is not the thread owner";
  on Messenger `(#10)`, subcode `2018300`, "another app controls the
  conversation". **Waiting does not help such an app**: when the conversation
  goes idle it belongs to the default app again.
- **With no default app** ("default" or "zero config" behaviour) every
  connected app receives `messaging` webhooks and "all connected applications
  can respond to the same user message without restrictions", until one of
  them asks for or is passed control.
- **Meta Business Suite's inbox** "takes control of the conversation" when
  someone answers there, or moves a message to its Main folder, in a
  conversation it didn't control. (Said on Messenger's page; Instagram's says
  only that the inbox is a connected app and can be the default.)
- **Meta's Business Agent** (its AI assistant), where a business has switched
  it on, also owns conversations; the same refusal results.
- **Take thread control** (`POST /{page-id}/take_thread_control`) is "only
  supported when conversation routing is enabled", and only for an app the
  business has allowed to "Take control of conversations". **Request thread
  control** (`POST /{page-id}/request_thread_control`) is the opposite: "only
  available when conversation routing is not enabled"; an idle conversation is
  handed over at once, otherwise the owner is told and may pass it on.
  **Pass** and **release** are for the app that has the conversation.

### What the business owner chooses, and where

Meta's pages give two routes to the same settings:

- **Meta Business Suite → Settings → Conversation routing**, or
- the Facebook Page (logged in as the Page) → **Settings → Page setup →
  Advanced messaging** → Connected apps; for Instagram, **Page setup →
  Instagram conversation routing**.

There the owner assigns the **default app**, separately for Messenger and for
Instagram, and, per connected app, whether it may **"Take control of
conversations"**. (There is a second switch, "Take control of conversations
with your Business Agent", off by default.) The menu names are as Meta's
developer pages give them; the Business Help Centre page could not be opened
from here, so check them against the screen.

Three ways to run, in the order we'd suggest them:

1. **One tool per channel.** Leave the other tool as the default for a
   channel and answer that channel there; or make this suite's app the default
   and answer here. Whichever app is _not_ the default for a channel can no
   longer reply on it (and only sees messages if it listens on `standby`).
   The owner's older help desk reads `messaging` only and subscribes to
   `feed,messages,message_echoes`, so once this suite is the default for
   Instagram that help desk will most likely stop receiving Instagram messages
   as well as being refused when it replies.
2. **Both, during a move.** Keep the usual tool as the default. In Meta's
   settings allow this suite's app to "Take control of conversations". In the
   workspace tick **Settings → Help desk → Channels → "If you also answer from
   another inbox tool" → "Take the conversation over when another tool has
   it"**. A reply from here that Meta refuses for thread control then takes
   that one conversation and is sent; the other tool gets it back when it goes
   idle. Replies from the other tool to a conversation this suite has taken
   are refused in the same way, unless it can take control too.
3. **No default app at all.** Meta's pages say every app can then answer. The
   two tools must not both answer the same message.

### What the suite does

- **A refusal for thread control is recognised** by Meta's numbers or its
  words (`ownedElsewhere` in `graph.ts`) and shown to the team as: "Another
  inbox tool is answering this conversation just now…", with what to do and
  Meta's own sentence under "Details". The reply stays in the outbox as
  failed, with "Put the words back in the box", and is **never sent again by
  itself**.
- **Nothing is taken by default.** Only with the workspace's `take_control`
  setting on (`helpdesk` / `channels`, owners and admins) does a refused reply
  lead to `take_thread_control`, then, if Meta refuses that,
  `request_thread_control`, and **one** more try at the reply, which is safe
  because the first try was refused outright. No clear answer is still "we
  don't know if it went" and is never retried.
- **Messages that arrive on `standby` are filed** exactly like those on
  `messaging` (`events.ts` reads both lists), so a conversation another tool
  is answering still shows here. Whether a message is filed never depends on
  who has control.
- **Who has the conversation** is noted on the person
  (`contacts.thread_control`, `_app`, `_at`, written only by
  `note_thread_control`): "other" from a standby message, a
  `take_thread_control` notice or a refused reply; "ours" from a
  `pass_thread_control` notice or a reply that went. The reply box shows a
  line when another tool had it at the last word from Meta, naming Meta's own
  inboxes and no other app. It is a heads-up with a time on it; it never
  blocks a reply. A `request_thread_control` notice (another app asking this
  one to hand over) is logged and nothing is handed over.
- **Webhook fields.** With messages switched on, a Page is now subscribed to
  `standby` and `messaging_handovers` as well; if Meta refuses those two, the
  Page is subscribed without them. Workspaces connected before this change
  get them the next time an owner presses Save on the Channels screen (or
  reconnects). Tick the same fields in the Meta app (below).
- Not done: passing or releasing control from here, extending control, and
  asking Meta who the owner is (`GET /{page-id}/thread_owner`, which only
  names the app to the owner or the default app). A private message about a
  comment that is refused for thread control gets the same explanation but is
  not retried.

## The automatic first reply (replacing Meta's instant reply)

Meta Business Suite's inbox can send an "instant reply" or "away message" by
itself. Because Meta's inbox sends it, Meta's inbox is the tool that answered
first, and a reply from the suite to that conversation is then refused with
"not the thread owner" (see the section above). The suite can send that first
message itself instead: **Settings → Help desk → Automatic replies**
(`helpdesk` / `auto_replies`; owners and admins).

### Fixed words only

What goes out is exactly what an owner or admin typed on that screen, with
two placeholders filled in by code: `{{first_name}}` (the person's first name
when the contact has one that looks like a name, "there" otherwise) and
`{{business_name}}` (the workspace's name). Anything else in double braces is
sent as typed, and the screen says so. **No model is asked for anything on
this path.** `src/lib/helpdesk/auto-reply/guard.test.ts` reads the source and
fails if the auto-reply folder, or the outbox and deliverers the words travel
through, come to import the Anthropic SDK or any of the suite's AI helpers.
The assistant may propose the switches, the hours and the quiet period, but a
proposal that changes a message is refused in code (`refuse` on the registry
entry): the words are only ever written by a person on the settings screen.

### What can be set

Per channel (Instagram messages, Facebook messages, email; all off by
default):

- on or off;
- **when**: whenever someone writes (`always`), only outside opening hours
  (`outside_hours`, the away message), or one message while open and another
  while closed (`both`);
- the message and the away message (plain text, up to 800 characters, and
  checked against what one Instagram or Facebook message can hold).

For the workspace: the weekly **opening hours** (the Bookings weekly-hours
shape, read on the workspace's own clocks with the same helper Bookings uses,
so daylight saving is followed) and the **quiet period** (1 to 168 hours,
24 by default).

The screen shows each message as it will read. "Send me a test" emails the
saved email reply to the signed-in person's own address and nowhere else; for
Instagram and Facebook there is only the preview, because a test would have
to go to a real person.

### When one is sent, and when not

Decided in code on the worker, when an inbound message has been filed
(`shouldAutoReply` in `auto-reply/rules.ts`), in this order. The first "no"
wins:

1. The channel's switch is off: no.
2. It isn't a real message from a person in a private conversation: no. That
   is a direct message, a story reply or a shared post (Instagram and
   Facebook), or an email. **Never** a comment on a post (those are public),
   a reaction, an unsend, a story mention, an echo of something sent from the
   app or by us, or a change of hands.
3. The conversation is in Spam or the Trash: no. (An archived one comes back
   when the customer writes, and is answered.)
4. Email only: it comes from one of the business's own addresses (the desk's
   address on our mail domain, or one listed under "your own addresses"), or
   it looks machine-sent: `Auto-Submitted` other than "no", `Precedence`
   bulk, list, junk or auto_reply, any `List-Id`, `List-Unsubscribe` or
   `List-Post`, `X-Autoreply`, `X-Autorespond`, `X-Auto-Response-Suppress`,
   `X-Loop`, `Feedback-ID`, an empty `Return-Path`, or a sender such as
   no-reply@, donotreply@, mailer-daemon@, postmaster@, bounce@ or
   notifications@. No.
5. Instagram and Facebook only: the message came on Meta's `standby` list
   (another tool has the conversation) and the workspace has not ticked "Take
   the conversation over when another tool has it": no.
6. The message is more than an hour old by the time the worker gets to it
   (a backlog, a delayed delivery): no. An "instant" reply that late only
   confuses.
7. Someone on the team has answered since that message, or has a reply
   waiting to go: no.
8. An automatic reply was already claimed for that person on that channel
   within the quiet period: no. A claim counts whether or not the reply went,
   so a refused one is not tried again on the person's next message.
9. The hours: `outside_hours` while open sends nothing; otherwise the usual
   or the away message is chosen by **when the person wrote**, not when the
   worker ran.
10. The chosen message is empty, or too long for one message: no.

Then the database takes the claim (`claim_auto_reply`): one row per inbound
message in `private.auto_replies`, taken under the conversation's and the
person's locks, with rules 2, 3, 7 and 8 checked again there. Two workers, a
redelivered webhook or a retried job get "duplicate". The claim puts the
reply into the same outbox every reply uses (`private.outbound_queue`), due at
once (no undo wait), with no author and marked automatic by the database (a
person's own reply can't carry that mark: `queue_outbound` takes it off).

It is sent by the same code as a person's reply (`sendSocialReply` for
Instagram and Facebook, with Meta's 24-hour window and the channel's switch
checked again; the mail service for email, with `Auto-Submitted:
auto-replied` and `X-Auto-Response-Suppress: All` so no other machine answers
it, and only ever to the person who wrote, never to anyone copied in).

How it is written down:

- **Sent**: filed in the conversation as the business's message, labelled
  "Automatic reply", with no author (`messages.automatic`). It is **not** the
  team answering: the status stays open, `first_reply_at` (the reports'
  first-reply time) stays empty, nobody is assigned, the list still shows the
  customer's message as the last thing said, and the manual neither reads it
  nor counts the conversation as answered because of it.
- **Refused** (Meta said no, thread control included, or the window had
  closed, or the mail service refused): written down once on the outbox row
  and on the claim, shown in the conversation as a quiet grey line ("The
  automatic reply to … wasn't sent, and isn't tried again", Meta's words
  under "Details"), with nothing kept to send again. It is never retried.
- **No clear answer**: "we never heard whether it went"; never sent again.

With "Take the conversation over" ticked (off by default), an automatic reply
refused for thread control takes or asks for the conversation and is tried
once more, exactly as a person's reply is.

### Switching Meta's own instant reply off

Switch the suite's on first, check a test message from a personal account
gets it, **then** switch Meta's off. Leaving both on means the customer may
get two automatic messages, and Meta's inbox, having answered, can take the
conversation, after which replies from the suite are refused.

Where Meta keeps it: **Meta Business Suite → Inbox → Automations** (the
"Instant reply" and "Away message" entries; switch each off, for Instagram
and for Messenger). **This path is from memory of Meta's product, not read
from a Meta page on the day**: business.facebook.com and Meta's Business Help
Centre could not be opened from the build machine. Check it against the
screen. Instagram's own app also has automated replies of its own (saved
replies, a welcome message, frequently asked questions under its business
tools); turn those off as well if they are in use.

Meta's inbox being off for the first message is not the whole of it. Which
app may answer a **new** conversation is still Meta's conversation routing
(above): if another app is the default there, the suite's automatic reply is
refused like any other reply from it. Make the suite's app the default for
the channel, or set no default app.

### What Meta's pages say about automated replies

Read on 25 November 2026 on developers.facebook.com ("Messenger Platform and
IG Messaging API policy", "Send a message", "Instagram Messaging overview",
"Rate limiting", and the two Conversation Routing pages):

- **The 24-hour window.** "Businesses have the duration of the standard
  messaging window to respond to a user … For most user actions, it lasts 24
  hours", and a person sending a message opens it. An automatic reply to an
  inbound message is always inside it; it is sent as `messaging_type:
RESPONSE` with no tag.
- **Saying it is automated.** "When required by applicable law, automated
  chat experiences must disclose that a person is interacting with an
  automated service: at the beginning of any conversation or message thread,
  after a significant lapse of time, or when a chat moves from human
  interaction to automated experience", with California and Germany named.
  "Even where not legally required, we recommend informing users". The suite
  does not add words of its own: the settings screen tells the owner to say
  so in the message ("This is an automatic reply").
- **A way to a person.** "Apps that use the Instagram Messaging APIs must
  have an escalation path to a human agent." The help desk is that: the
  conversation stays open for the team.
- **Rate limits.** Send API: 300 calls a second per Facebook Page and 100 a
  second per Instagram professional account for text messages; Messenger
  overall, 200 × the number of people the business can message, per rolling
  24 hours. One short reply per person per quiet period is far inside these.
  Error 613 is "rate limit exceeded"; like any refusal it is written down and
  not retried.
- **Thread control.** With no default app, "all applications can respond to
  the same user message without restrictions" and "coordination of responses
  from both the application and page inbox is necessary to ensure no
  duplicate responses". With a default app, only the thread owner may send
  while a conversation is active and only the default app while it is idle.
  Meta's inbox "takes control of the conversation" when someone responds
  there in a conversation it didn't control. **Meta's pages do not say that
  an app's own send through the Send API takes thread control**, and do not
  say in so many words that the inbox's automated instant reply counts as
  the inbox responding (what the owner saw on staging fits it). So the suite
  sending the first message is not, by itself, a way to hold a conversation:
  what removes the refusal is Meta's inbox no longer answering first, plus
  the routing choice above.

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
     messages, plus **`standby`** and **`messaging_handovers`** so a business
     that also uses another inbox tool still gets its messages here (see
     "Using this alongside another inbox tool"); **`feed`** for Facebook
     comments
   - **Instagram** object: `messages`, `message_reactions` for messages, plus
     **`standby`** and the hand-over field (the dashboard lists it as
     `messaging_handover`); **`comments`** for Instagram comments. Leave
     `live_comments` and `mentions` unticked (they are ignored).
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
`supabase/migrations/20270110000100_helpdesk_social.sql`; several accounts came
with `20270128000200_social_accounts.sql` and
`20270128000400_helpdesk_accounts.sql`.

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
- Several Pages, end to end: that `/me/accounts` returns each shared Page's
  own `access_token` and `tasks` with the fields asked for, that the task names
  are still `MANAGE`, `CREATE_CONTENT`, `MESSAGING` and `MODERATE`, that a
  Page-scoped or Instagram-scoped person id really differs between two
  accounts (the threading per account relies on it), and how Facebook's
  dialog lets a person add Pages to an existing login. All written from
  Meta's documentation as remembered, not read on the day.
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
- Thread control, end to end. Seen on staging: an Instagram message filed
  from `messaging` and the reply refused with "(#100) The action is invalid
  since it's not the thread owner." (no subcode was noted). Not seen: a
  delivery on `standby`, a `messaging_handovers` notice, `take_thread_control`
  or `request_thread_control` answered by Meta, whether a Page can be
  subscribed to `standby` and `messaging_handovers` before the app has those
  fields ticked (the suite falls back to subscribing without them), and the
  name of the hand-over field on the Instagram object (`messaging_handover` in
  Meta's routing page, `messaging_handovers` in its webhook reference; the
  suite reads the events by their content, not the field's name). Why that
  staging message came on `messaging` although another app owned the
  conversation isn't settled by Meta's pages: either no default app is set
  and the other app or Meta's inbox had taken the conversation, or this app is
  the default and Meta's inbox took it when someone opened or answered it
  there. The payload isn't kept once filed, so it can't be looked at again.
- The automatic first reply, end to end against Meta: that a `RESPONSE`
  message sent within seconds of the inbound one is accepted on both
  platforms, that switching Meta's instant reply off stops Meta's inbox
  taking the conversation, where exactly that switch sits in Meta Business
  Suite today (written from memory: Inbox → Automations), and whether Meta's
  echo of an automatic reply carries our `app_id` (either way it is matched
  by message id and not filed twice). The email reply has not been sent
  through the mail service either; the request it builds is tested.
- Which optional permissions each use case really offers in the owner's app
  dashboard. The table at the top is Meta's documentation on the day; the
  dashboard is the authority.
