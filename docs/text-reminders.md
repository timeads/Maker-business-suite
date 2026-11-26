# Text reminders

People who book can ask for text reminders. The texts go from **your own Twilio account and number**, and Twilio bills you for them directly. Nothing is texted to anyone who didn't tick the box.

Everything is off until you switch it on.

## 1. Connect Twilio

You need a Twilio account with a phone number that can send texts (or a Messaging Service). In the [Twilio console](https://console.twilio.com):

1. On the home page, under **Account Info**, copy the **Account SID** (it starts with `AC`) and the **Auth token** (press **Show** first).
2. Under **Phone Numbers → Manage → Active numbers**, note the number texts should come from, written with `+` and the country code, like `+12155550134`. If you send through a **Messaging Service** instead, copy its id (it starts with `MG`).

Then, in the suite, go to **Connections → Twilio**, paste the three, and press **Connect**. We check them with one look at your Twilio account; nothing is sent. Your auth token is locked away and never shown again. To stop, press **Disconnect**: we forget the keys, and your Twilio account stays as it is.

A **trial** Twilio account can only text numbers you have checked in Twilio, and Twilio adds its own words to every text. The Connections page says so when that is what you connected.

## 2. Make STOP work

When someone replies STOP, they must get no more texts. Twilio tells us about replies through a webhook. In the Twilio console:

1. Open **Phone Numbers → Manage → Active numbers** and choose your number (or open your **Messaging Service → Integration**).
2. Under **Messaging configuration**, set **A message comes in** to **Webhook**, method **HTTP POST**, and paste this address:

   `https://<your suite address>/api/webhooks/twilio`

   The exact address is shown on **Settings → Bookings → Text reminders**.

3. Save.

Every request is checked against Twilio's signature with your own auth token, so nobody else can opt your customers out or in. When a reply of STOP (or STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPT OUT, REVOKE) arrives, every booking in your workspace with that number stops getting texts, and the number is noted so a text already waiting isn't sent.

Twilio also answers STOP itself and blocks further texts from your number to that person. A reply of START unblocks them at Twilio's end, but it doesn't sign them up here again: they tick the box on their next booking. This is how the earlier booking app behaved too.

## 3. Choose your texts

**Settings → Bookings → Text reminders**:

- **Send text reminders** switches the whole thing on.
- **Which texts go**: "You're booked", a reminder (48 hours before unless you change it), a day-of reminder (2 hours before), a thank-you (24 hours after), "cancelled by a shop refund" and "moved to another date". Each has its own tick and its own words. The standard words are the earlier booking app's texts, made to fit any business.
- **Fill-ins** such as `{{first_name}}`, `{{workshop}}`, `{{date}}` and `{{time}}` are filled in from the booking, on your workspace's clock with its zone ("ET"). Nothing else is ever added: no text is written or changed by AI.
- The **count** under each text says how many parts it will be sent in. Twilio charges per part: 160 plain characters fit in one; curly quotes, accents outside the basic set and emoji mean only 70 fit.
- **The opt-out line** ("Reply STOP to opt out.") goes on the end of every text that doesn't already say STOP. It must mention STOP.
- **Numbers without a country code** are read as numbers of the country you choose (United States, Canada, United Kingdom, Ireland, Australia or New Zealand). A number we can't read for sure gets no texts, rather than a guess; the Messages sent list says so.
- **Send me a test text** sends one text with a made-up booking to a number you type and say is your own. Three an hour each, ten a day for the workspace.

## 4. Consent: what you must do

You are the sender, so the consent is yours to collect and keep.

- When texts are on and Twilio is connected, the **date picker on your shop's product page** and **your booking page** show an optional mobile number box and a tick box with your consent words. The standard words are the earlier app's: "Text me booking reminders & updates (optional). Msg & data rates may apply; reply STOP to opt out." Change them on the settings screen if your lawyer or Twilio's rules ask for something else.
- Only a ticked box with a number counts. The number and the tick travel with the cart line (hidden from checkout) to the order, and from the order to the booking. Carts started in the earlier booking app carry its own two hidden fields, which are read the same way.
- A tick on the shop's own checkout ("text me offers") is **not** read as consent for booking texts.
- Texts are about the booking only. Don't use these numbers for marketing.
- In the United States, sending from a 10-digit number (10DLC) needs your brand and campaign registered with Twilio first; toll-free numbers need verification. Other countries have their own rules. Twilio's console walks you through it.

## 5. Seeing what went

**Bookings → Messages sent** lists every email and text that went out by itself, with a filter for emails or texts. A text Twilio refused shows Twilio's own words. A refusal that may pass (Twilio busy, say) is tried again, three times in all; one Twilio refused for good (not a mobile number, or the person replied STOP) isn't. One we never heard back about is marked "Not sure it went" and is never sent again by itself.

## What isn't built

- Twilio's delivery reports (status callbacks): a text counts as sent once Twilio has taken it.
- Texts for a date cancelled by you, a date's time changed, or a person cancelled by you. These still go by email.
- Texts to the team (the owner's notes and the daily email are email only).
