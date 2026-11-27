# Switching the help desk over

Read [the shared list](README.md) first: what has to be true of the live site before any tool moves.

Your earlier help desk reads your Gmail and answers from it. The suite works differently: **your support email is forwarded to the suite's help desk address**, and replies go out from that address. The earlier help desk app also does your shipping, so it **stays running for packing** after the inbox moves; only its mailbox and its Facebook and Instagram are disconnected.

## Before the day

**Connections**

- **Facebook & Instagram** (optional): Settings → Help desk → Channels → "Allow messages on Facebook". It asks only for the messaging permissions; comments on posts are asked for separately on the same screen ([meta-messages.md](../meta-messages.md), "Switching it on in a workspace").
- **Your shop**: already connected for the other tools. The rail beside a conversation shows the customer's orders from it.

**Settings to copy across by hand.** There is no import; type these in from your earlier help desk.

| From your earlier help desk                | Here                                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved replies (macros)                     | Settings → Help desk → Inbox & replies → Saved replies. Put your sign-off in them: there's no signature setting.                                     |
| Rules for new mail (tag, priority, assign) | Settings → Help desk → Inbox & replies → Rules for new email                                                                                         |
| Undo seconds, what happens after closing   | Settings → Help desk → Inbox & replies → How the desk behaves                                                                                        |
| Folders and saved views                    | "New folder" in the help desk's menu; saved views and tag groups on Inbox & replies                                                                  |
| The address customers write to             | Settings → Help desk → Inbox & replies: add it as an address you forward from, so "Reply all" leaves it out                                          |
| Away message / instant reply               | Settings → Help desk → Automatic replies (fixed words only). Leave it **off** until "On the day", step 6.                                            |
| Repair manual topics and help articles     | Help desk → Manual, set up under Settings → Help desk → Manual and Help centre. Write or paste the ones you rely on; nothing comes across by itself. |

Then work through **Help desk → Set up** (its menu row carries the count).

**Decide how Facebook and Instagram messages will be answered.** Meta lets one tool at a time answer a conversation. The simplest is one tool per channel: on the day, make the suite's app the default in Meta's conversation routing (Meta Business Suite → Settings → Conversation routing). The other routes, and what each means, are in [meta-messages.md](../meta-messages.md), "Using this alongside another inbox tool".

## What will be different

- **Replies come from the help desk address**, not from your own Gmail, and nothing is kept in your Gmail's Sent folder. Customers who reply land back here.
- **Older email isn't brought in.** Only mail that arrives from the switch on. Past conversations stay in Gmail and in the earlier app.
- **No live chat on your website.** If the earlier app's chat is on your site, either keep answering chats there (it stays running for shipping) or take the chat off your site.
- **No suggested replies written by themselves.** Claude drafts one when you press for it, against the plan's allowance.
- **Rules only run on new mail and never send anything.** The only thing sent by itself is the automatic first reply, in your fixed words.
- **No handing out new conversations by turns or by load**; a rule can name one person.
- **No discount codes from the reply box** (the shop connection can't make them).
- **Email shows as plain text**, never as the designed email; one subject per conversation; a pasted reply loses its formatting.
- **Parcels in the details rail are only ones recorded in the suite's Shipping**, so until Shipping moves, the rail shows no tracking for orders you pack in the earlier app. Customer tags and the shop's note on a customer aren't shown; the phone is the one on their latest order.
- **No AI cost page and no "when tickets arrive" chart.** Saved views sit under one "Views" heading; merging is one conversation at a time; "Ship" from a conversation isn't there.
- **The knowledge base doesn't publish to your shop's blog**, doesn't pull in website pages and doesn't check links. The help centre lives on the suite's own site.

## On the day, in order

Pick a quiet hour. The order matters: mail must reach the suite **before** the earlier help desk stops reading it, so nothing falls between the two.

1. **In your earlier help desk, switch off every rule that replies by itself**, so no customer gets an automatic answer from both.
2. **Clear what you can** from the earlier help desk's open list. Whatever is left is answered from Gmail directly after step 5 (the earlier app can't send once its mailbox is disconnected). **To confirm** on the earlier app's screen.
3. **Forward your support mail.** In Gmail: Settings → Forwarding, add the address shown on Settings → Help desk → Inbox & replies ("Your help desk address"), and choose to **keep Gmail's copy**. Gmail first sends a confirmation message to that address: it arrives in the help desk as a conversation; open it and follow its link. **To confirm:** that Gmail's confirmation arrives as a conversation and not as a message the desk sets aside.
4. **Send a test** from a personal email address to your support address. It should appear in the help desk within a minute or two. Reply to it, and reply back from the personal address: the answer should thread into the same conversation.
5. **As soon as the test arrives, disconnect the mailbox in your earlier help desk's settings**, so it stops reading Gmail. Between steps 3 and 5 new mail is in both: answer it only in the suite. **To confirm:** the name of the earlier app's disconnect button, and that its shipping screens keep working without the mailbox.
6. **Switch on the automatic reply for email**, if you want one (Settings → Help desk → Automatic replies). Your earlier one is already off from step 1.
7. **Facebook and Instagram**, if you're moving them today:
   1. Switch them on at Settings → Help desk → Channels and send a test message from a personal account.
   2. Make the suite's app the default for each channel in Meta's conversation routing.
   3. Switch on the suite's automatic reply for that channel, check a test message gets it, **then** switch Meta's own instant reply and away message off ([meta-messages.md](../meta-messages.md), "Switching Meta's own instant reply off"). Both on means two automatic messages.
   4. Disconnect Facebook and Instagram in your earlier help desk.

## Check it worked

**First hour**

- The test email and its reply sit in one conversation, and your reply came from the help desk address.
- A test Instagram or Facebook message appears under "Instagram & Facebook" in the help desk's menu, and your reply arrives on the phone it came from.
- Exactly one automatic reply reached each test, from the suite.

**First day**

- New customer email keeps arriving here. Gmail's inbox has its copies (you chose to keep them), and the earlier help desk has nothing new.
- Messages: no heads-up about a message that couldn't come in.

## If something goes wrong

- **Email:** turn Gmail's forwarding off and connect the mailbox in your earlier help desk again. Because Gmail kept its copies, the earlier app can read what arrived meanwhile. **To confirm:** how far back the earlier app reads when reconnected.
- **Facebook and Instagram:** make the earlier help desk the default again in Meta's conversation routing, connect it again, and switch Meta's instant reply back on if you used it.
- Conversations that came in here stay here; answer them here or from Gmail.

What can't be undone: a reply that has gone (the undo wait on Inbox & replies only lasts the seconds you set), and an automatic reply already sent.

## Still needs a decision or isn't ready

- **The live site update** ([the shared list](README.md), item 1). The whole of today's help desk (files, shelves, the outbox, the manual, Facebook and Instagram, the automatic reply) is in it. Needs your go-ahead.
- **Mail in and out on the live site:** `INBOUND_EMAIL_DOMAIN` must be a domain Postmark receives for and also a verified sending domain, with the inbound webhook set ([the shared list](README.md), item 3).
- **Facebook and Instagram** need the live site's Meta keys and webhook, and Meta's review of the messaging permissions for accounts outside the app's own team.
- **Claude drafts and the manual** need `ANTHROPIC_API_KEY` on the live site.
- **Sending from your own Gmail** and **live chat** aren't built. If either is a must, it blocks this switch.
