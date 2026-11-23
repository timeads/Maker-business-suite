/**
 * The help pages' articles. Plain data, written for makers: what to press and
 * what happens. Each one describes what the app really does today; when a
 * screen changes, change its article in the same commit.
 */
export type HelpTopic = {
  slug: string;
  group: HelpGroup;
  title: string;
  /** One line, shown in lists and search. */
  summary: string;
  /** A sentence or two before the steps. */
  intro?: string;
  steps?: string[];
  /** Things worth knowing, after the steps. */
  notes?: string[];
};

export const HELP_GROUPS = [
  { key: "start", name: "Getting started" },
  { key: "helpdesk", name: "Help desk" },
  { key: "shipping", name: "Shipping" },
  { key: "stock", name: "Stock" },
  { key: "bookings", name: "Bookings" },
  { key: "social", name: "Social and emails" },
  { key: "money", name: "Money" },
  { key: "team", name: "Team, messages and the assistant" },
  { key: "account", name: "Plans and your account" },
] as const;
export type HelpGroup = (typeof HELP_GROUPS)[number]["key"];

export const HELP_TOPICS: HelpTopic[] = [
  // ------------------------------------------------------------------ start
  {
    slug: "first-steps",
    group: "start",
    title: "Your first ten minutes",
    summary: "Set up a workspace, your brand kit and your shop connection.",
    intro:
      "A workspace is your business's own space in the suite. Everything you and your team do lives inside it.",
    steps: [
      "Sign in and name your workspace. Pick your time zone and currency: dates and money follow them everywhere.",
      "Set up your brand kit when asked (see “Build your brand kit”). It takes about two minutes.",
      "Open Connections and connect your shop, so your orders, products and customers come in.",
      "Open Home. Each tool has a card that says what's waiting for you today.",
    ],
    notes: [
      "You can change the workspace name, time zone and currency later under Settings.",
      "Nothing is sent to your customers until you press a button that says so.",
    ],
  },
  {
    slug: "brand-kit",
    group: "start",
    title: "Build your brand kit",
    summary: "Your colours and the way you sound, used for everything Claude drafts.",
    intro:
      "The brand kit lives under Settings → Brand kit. Claude reads it before drafting a post, caption or email, and your email and picture designs are drawn from it.",
    steps: [
      "Choose how to start: answer five questions (“Build it with me”), upload your brand guide as a PDF or picture, or fill it in yourself.",
      "If you asked Claude, look over what it suggests. Change any colour, word or note you like.",
      "Check the preview on the right. Text colours are chosen for you so words stay readable on every background.",
      "Press “Save brand kit”. Nothing is saved until you do.",
    ],
    notes: [
      "Include one dark and one light colour. The first colour in the list is your main one.",
      "“Words you never use” is honoured in drafts, so it's a good place for words that aren't you.",
      "Only owners and admins can change the kit.",
    ],
  },
  {
    slug: "appearance",
    group: "start",
    title: "Light, dark and your own colours",
    summary: "Choose how the suite looks for everyone in your workspace.",
    steps: [
      "Open Settings → Brand kit and find Appearance at the top.",
      "Pick Light (a dark menu beside a light page), Dark, or Match my device.",
      "Tick “Use my brand colours” to put your kit's colours on the menu and main buttons.",
      "Press “Save appearance”.",
    ],
    notes: [
      "Shades are adjusted where needed so the menu and buttons stay readable.",
      "Pages your customers see, like booking pages, are always light.",
    ],
  },
  {
    slug: "connect-shop",
    group: "start",
    title: "Connect your Shopify shop",
    summary: "Bring in orders, products, stock counts and customers.",
    steps: [
      "Open Connections and find Shopify.",
      "Type your shop's address, the one ending in .myshopify.com, and press Connect.",
      "Shopify asks you to approve. Say yes, and you're brought back here.",
      "The first sync starts by itself. Orders from the last two years, your products and stock counts arrive over the next few minutes.",
    ],
    notes: [
      "New orders arrive as they happen, with an hourly check as a safety net.",
      "If Stock or Shipping say your shop hasn't given permission for something, disconnect and connect again: that asks Shopify for the newer permissions.",
      "One shop per workspace.",
    ],
  },
  {
    slug: "phone",
    group: "start",
    title: "Use the suite on your phone",
    summary: "Add it to your home screen and share photos straight into Assets.",
    steps: [
      "Open the suite in your phone's browser and sign in.",
      "Use the browser's menu to “Add to Home screen”. It then opens like an app.",
      "On Android, the suite appears in the Share menu: share photos or videos from your gallery and they land in Social → Assets, tagged “shared”.",
      "On an iPhone, open Social → Assets and press “Choose files”, which opens your photo library.",
    ],
    notes: [
      "The menu sits along the bottom on a phone, with the rest behind “More”.",
      "The email builder needs a wider screen; use a computer for that.",
    ],
  },

  // --------------------------------------------------------------- helpdesk
  {
    slug: "support-address",
    group: "helpdesk",
    title: "Get customer email into the help desk",
    summary: "Your workspace has its own support address; forward your mail to it.",
    intro:
      "Each workspace has one support address, shown at the top of Help desk settings. Mail sent to it becomes a conversation in your inbox.",
    steps: [
      "Open Help desk → Settings and copy your support address.",
      "In your own email (Gmail, Outlook and so on), set your support mailbox to forward to that address.",
      "Send yourself a test. It should appear in the inbox within about a minute.",
    ],
    notes: [
      "Only mail to that exact address is filed. Mail to any other name at the same domain is set aside.",
      "A customer's reply to one of your answers goes back into the same conversation.",
    ],
  },
  {
    slug: "answer-customers",
    group: "helpdesk",
    title: "Answer a customer",
    summary: "Reply, use a saved reply, or let Claude draft one for you to edit.",
    steps: [
      "Open a conversation. If the customer has ordered from your shop, their orders are shown beside the message.",
      "Write your reply, pick a saved reply, or press the draft button for a first draft from Claude.",
      "Read it through and change what you like. Then press Send.",
      "Close the conversation when it's done, or snooze it to bring it back on a later day.",
    ],
    notes: [
      "A draft from Claude only fills the reply box. It is never sent unless you press Send.",
      "Notes are for your team only and are never emailed.",
      "Tags, priorities and who it's handed to can be set by hand, or by rules in Settings.",
    ],
  },
  {
    slug: "reply-not-sending",
    group: "helpdesk",
    title: "My reply won't send",
    summary: "What the message under the reply box means, and what to do.",
    intro:
      "When a reply can't be sent, nothing goes out and the help desk says why. The two usual reasons are about how sending was set up, not about your reply.",
    steps: [
      "“The support address hasn't been confirmed for sending”: the domain your support address uses still needs verifying with the mail service. Whoever set up your email needs to finish that.",
      "“Waiting for approval from the mail service”: a new mail account can only write to its own domain until it is approved. Ask for approval, then try again.",
      "“This address has bounced before”: the mail service won't send to that customer's address. Check it with them another way.",
      "Anything else: wait a minute and press Send again. Your words are still in the box.",
    ],
  },

  // --------------------------------------------------------------- shipping
  {
    slug: "to-ship",
    group: "shipping",
    title: "Work through what's waiting to ship",
    summary: "Views, search, holds and marking an order as sent.",
    steps: [
      "Open Shipping. “Ready to ship” lists paid orders with something left to send, oldest first.",
      "Use the views along the top for pickup orders, priority shipping, payment pending, on hold and international.",
      "Open an order to see what to pack. Record the parcel with its carrier and tracking number, or buy a label (see “Buy a postage label”).",
      "Sending only part of an order? Enter how many of each item went. The rest stays in the queue.",
    ],
    notes: [
      "Put an order on hold with a note and, if you like, the day it should come back. It returns marked “Back from hold”.",
      "If Shipping settings say so, recording a parcel also marks the order as sent in your shop, and your shop emails the customer their tracking.",
      "The number beside Shipping in the menu is how many orders are ready to go.",
    ],
  },
  {
    slug: "packing-slips",
    group: "shipping",
    title: "Packing slips and Scan & pack",
    summary: "Print slips your way, then scan items as you pack.",
    steps: [
      "In Shipping → Settings, choose what prints on a slip and in what order, and add a thank-you message.",
      "Tick orders in “To ship” and press “Packing slips” to print them.",
      "Open Scan & pack and scan a slip's barcode, or type the order number.",
      "Scan each item's code as it goes in the box. When everything is packed, record the parcel.",
    ],
    notes: [
      "A wrong scan is called out straight away, so the wrong item doesn't go out.",
      "No scanner? Use the plus and minus buttons, or “Mark all packed”.",
    ],
  },
  {
    slug: "buy-label",
    group: "shipping",
    title: "Buy a postage label",
    summary: "Connect a postage account, save your boxes, then buy and print from the order.",
    intro:
      "Labels are bought through your own postage accounts: EasyPost, your own UPS account, Redo, or any mix of them. You pay each one directly, and their prices are shown together in one list.",
    steps: [
      "Open Connections and connect at least one postage account. For EasyPost, paste in your API key; a test key buys pretend labels, which is a good way to try it. To add UPS or Redo, see “Use your own UPS account or Redo for postage”.",
      "In Shipping → Settings, fill in where you ship from (street, city, state, postcode and phone) and add the boxes you pack in.",
      "Open an order. The address is checked for you, and if your usual box and the weight are known, the rates are already waiting.",
      "Fix the address if it needs it (the change is for this label only), pick the box, and choose whether a signature is needed. Then press “Get rates” if they aren't showing.",
      "Choose a service. The list is cheapest first, and a small tag on each price says where the label would be bought: “via EasyPost”, “your UPS account” or “via Redo”.",
      "Press “Buy & print label”, or Ctrl+P. The label opens to print, and the parcel and tracking number are recorded for you.",
    ],
    notes: [
      "With more than one box, say what goes in each: a Box 1 / Box 2 switch for a single item, a count per box for several, or “Split evenly”. Where your shop has product weights, each box's weight follows what's in it.",
      "Each rate shows what's left of the shipping your customer paid, so you can see when a label costs more than they were charged.",
      "When the same service is on offer from more than one account, you see it once, at the cheapest, with what the others would charge underneath.",
      "If one account can't be reached, its prices are left out and a line under the list says so. The rest still work.",
      "In Shipping → Settings you can ask for a signature on every order over an amount.",
      "Use the arrows at the top (or J and K) to go to the next order without going back to the list.",
      "A label covers everything left on the order. For a part shipment, record the parcel by hand instead.",
      "An order can go in several boxes. Press “Add another box”, weigh each one, and you buy them together: one label and tracking number per box, all on the same parcel.",
      "International labels need a customs form, which isn't built yet. Buy those elsewhere and record the parcel by hand.",
      "Owners and admins can void a label. That asks whoever sold it (EasyPost, UPS or Redo) to cancel it and puts the items back in the queue.",
      "The suite won't buy the same label twice, even on a double press.",
      "Got a Zebra thermal printer at the packing bench? Labels can go straight to it with no print window. See “Print labels straight to a Zebra printer”.",
    ],
  },
  {
    slug: "zebra-printing",
    group: "shipping",
    title: "Print labels straight to a Zebra printer",
    summary:
      "Set up the packing computer once, and labels come out of the Zebra the moment you buy them.",
    intro:
      "A Zebra thermal printer can take labels directly, with no print window and no new tab. The choice belongs to the computer, not the workspace: the packing bench prints to its Zebra while the office desk carries on printing through the browser.",
    steps: [
      "On the packing computer, install Zebra Browser Print (free, from zebra.com) and leave it running. In its own settings, make your label printer the default.",
      "In the same browser you use for the suite, open localhost:9101/ssl_support once and accept it. That lets this site talk to Browser Print. If the browser asks whether this site may reach apps or devices on this computer, say yes.",
      "Open Shipping → Settings on that computer. Under “Printing on this computer”, choose “Zebra thermal printer”.",
      "Press “Find printers” and pick yours if there's more than one. Most Zebras are 203 dpi; change that only if yours is a 300 dpi model.",
      "Press “Print test label”. A small label with a barcode should come out.",
      "From then on, “Buy & print label” sends the label straight to the Zebra. With several boxes, the labels come out in box order.",
    ],
    notes: [
      "If the printer can't be reached when you buy, the label is still bought and saved on the order. Nothing is bought twice. Fix the printer and press “Print again”, or open the label and print it the ordinary way.",
      "Every label remembers when it was last printed, on any computer. Before a second copy comes out you're asked first, because only one copy of a label can be used.",
      "You can print any label again later from the order's “Already sent” list.",
      "Labels bought on a Zebra computer are in the printer's own format. On another computer they open as a file rather than a picture, so reprint those from the packing bench.",
      "Labels bought as pictures (on another computer, or from Redo) are redrawn for the Zebra when you print them. So is a Redo label that arrives as a PDF: each page comes out as its own label. If one can't be drawn, the page says so, and you can open the label and print it the ordinary way.",
      "Packing slips can go to the Zebra too, on the same 4 × 6 labels: open Packing slips and press “Print on the Zebra”. A long order runs onto a second label.",
      "Nothing printing? Check that Browser Print is running (its icon is in the system tray or menu bar), that the printer is on, has labels and isn't paused, then press “Print test label” again.",
      "The setting is kept in that browser. A different browser, or clearing the browser's saved data, means choosing it again.",
    ],
  },
  {
    slug: "own-ups-or-redo",
    group: "shipping",
    title: "Use your own UPS account or Redo for postage",
    summary: "Add UPS or Redo beside EasyPost and see every price in one list.",
    intro:
      "If you have your own UPS account, or buy postage through Redo, you can connect them and buy those labels here. Both are optional, and they work alongside EasyPost or without it.",
    steps: [
      "For UPS: sign in at developer.ups.com with your UPS login, add an app for your shipper account, and give it the Rating and Shipping products (add Address Validation too if you'd like addresses checked). The app's page shows a Client ID and a Client Secret.",
      "Open Connections, find “UPS (your own account)”, and paste in the Client ID, the Client Secret and your six-character UPS account number. Choose practice labels first if you'd like to try it without being billed, then press Connect.",
      "For Redo: in Redo, open Settings, then Developer. Copy “Your Store ID” and make an API token with the Shipping read and Shipping write permissions.",
      "Open Connections, find Redo, paste in the token and the store ID, and press Connect.",
      "Open an order in Shipping and get rates as usual. Prices from every connected account appear together, each tagged with where it comes from.",
    ],
    notes: [
      "We check what you paste by asking for one sample price. Nothing is bought.",
      "Your keys are locked away once saved and never shown again. To change them, disconnect and connect again.",
      "UPS labels are billed by UPS to your account at your own agreed prices. Redo labels are paid from your Redo labels balance, so keep it topped up.",
      "When Redo offers USPS, EasyPost's USPS prices are left out, since they cost the same. They come back if Redo can't be reached.",
      "Redo only shows prices for an order that needs a signature when it can add the signature itself. Otherwise its prices are left out for that order, with a note.",
      "If UPS or Redo stops answering in the middle of a purchase, we can't ask them afterwards whether it went through. The order is held under “Labels to finish” until an owner or admin has looked in that account and cleared it, so nothing is bought twice.",
      "Voiding a UPS label cancels it with UPS. Voiding a Redo label asks Redo to cancel it and put the postage back on your balance.",
    ],
  },
  {
    slug: "ship-together",
    group: "shipping",
    title: "Send several orders together",
    summary: "One box and one label for orders going to the same person and address.",
    intro:
      "When a customer orders twice before you've packed, the orders can share a parcel. You buy one label, and each order is still marked as sent on its own.",
    steps: [
      "Open Shipping. When two or more orders are waiting for the same person at the same address, a “Ship together?” line appears above the list. Press “Ship together”, or “Not now” to leave them apart.",
      "Or pick them yourself: tick two to ten orders and press “Ship together”.",
      "If the addresses don't read exactly the same, you're shown both. Say yes only if they really are one place: the label goes to the oldest order's address.",
      "The orders open as one, named like “#1042 + #1055”, with every item marked with the order it came from. Pick boxes and get rates as usual.",
      "Press “Buy & print label”. Every order is recorded as sent with the same carrier and tracking number.",
    ],
    notes: [
      "Small spelling differences don't matter: “12 Oak Street, Apt 3” and “12 OAK ST #3” count as the same address. Email isn't compared.",
      "Orders on hold, for pickup, still waiting on payment or already sent aren't suggested. A part-sent order joins in with what's left.",
      "“Not now” hides a suggestion until another order comes in for that address.",
      "Not buying yet? Press “Save for later” and the orders wait together at the top of the list for whoever buys the label. “Separate” sends them back to their own rows.",
      "“One packing slip” prints a single slip listing everything, with each line's order number.",
      "What your customer paid for shipping is added up across the orders, so the rates show what's really left over. A signature rule looks at the orders' combined total too.",
      "If your shop is told when parcels go, each order is marked as sent there, so your customer gets one email per order with the same tracking.",
      "Voiding the label (owners and admins) undoes every order in the parcel at once.",
      "Sending part of an order and putting orders on hold aren't offered while orders are open together. Open one on its own for those.",
    ],
  },
  {
    slug: "pickup",
    group: "shipping",
    title: "Orders the customer collects",
    summary: "Mark a pickup order ready, then collected.",
    steps: [
      "Open the “In-store pickup” view in Shipping.",
      "When the order is packed, press “Mark ready for pickup”.",
      "When the customer has it, open the order and press “Mark picked up”. It leaves the queue.",
    ],
    notes: ["These steps are kept in the suite. They don't change anything in your shop."],
  },

  // ------------------------------------------------------------------ stock
  {
    slug: "reorder-suggestions",
    group: "stock",
    title: "How reorder suggestions are worked out",
    summary: "What “runs out”, “order by” and the suggested quantity mean.",
    intro:
      "Stock looks at what each item has sold, how many you have, and how long your supplier takes, and works out when to order and how many.",
    steps: [
      "“Runs out” is when you'd sell your last one at the current pace, counting anything already on order.",
      "“Order by” is that date, less the supplier's lead time and a small buffer you set in Settings.",
      "The suggested quantity covers the lead time plus the days of cover you want, plus any safety stock, less what you have and what's coming.",
      "Suggestions round up to whole cases, and respect the smallest order you or your supplier set.",
    ],
    notes: [
      "Lead time and days of cover come from the supplier unless an item has its own.",
      "Every figure is worked out fresh each time you look; nothing is stored, so it's never stale.",
    ],
  },
  {
    slug: "draft-order",
    group: "stock",
    title: "Draft an order to a supplier",
    summary: "Tick items and let the suite fill in the quantities.",
    steps: [
      "Open Stock → Everything, or start from “To order” on the Stock front page.",
      "Tick the items you want and press “Draft an order”. You get one draft per supplier.",
      "Each line starts at the suggested quantity and says how it was reached. Change any you like.",
      "Add shipping, tax or other amounts if you know them, then mark the order as sent when you place it.",
    ],
    notes: [
      "Items with no supplier are listed as left off, so nothing is dropped quietly.",
      "You can print the order or download it as a spreadsheet to send to your supplier.",
      "Lines stay editable until the order is closed, so it can match what really arrived.",
    ],
  },
  {
    slug: "dont-reorder",
    group: "stock",
    title: "Stop an item appearing in reorders",
    summary: "For gift cards, one-offs and anything you won't restock.",
    steps: [
      "Tick the items on Stock → Everything and press “Don't reorder”, or flip the switch on an item's own page.",
      "They leave the suggestions and can't be added to draft orders.",
      "Find them again under the “Not reordering” view, where you can bring them back.",
    ],
    notes: [
      "In Stock → Settings you can list words that hide matching items automatically. It starts with “gift card”.",
    ],
  },
  {
    slug: "check-in-delivery",
    group: "stock",
    title: "Check in a delivery",
    summary: "Record what arrived and add it to your shop's count.",
    steps: [
      "Open the order under Stock → Orders.",
      "Enter how many of each item arrived and press to check them in. Anyone on the team can do this.",
      "If you've switched it on in Settings, the arrived quantity is added to the count in your shop.",
      "When everything has arrived, the order closes by itself.",
    ],
    notes: [
      "The suite only ever adds what you checked in. It never lowers or overwrites your shop's count.",
      "Adding to the shop's count needs a shop with one stock location.",
      "Add tracking numbers to an order that's on its way and it shows under “Incoming”, with a flag if it's late.",
    ],
  },
  {
    slug: "supplier-balances",
    group: "stock",
    title: "Keep track of what you owe suppliers",
    summary: "Invoices, payments and statements, with what's due and when.",
    intro: "Stock → Balances is a running account for each supplier. Owners and admins can see it.",
    steps: [
      "Open a supplier and add their invoices and your payments as they happen.",
      "When they send a statement, add its balance. That becomes the true figure on that date, and everything after it is added on.",
      "The summary page shows the total due, what's past due, and when each bill falls due.",
      "Tick “Paid” on a bill when you've sent the money. Add the payment itself when it has gone through.",
    ],
    notes: [
      "Typed an amount wrong? Add the invoice again with the same number and it's corrected, not counted twice.",
      "A credit with one supplier is never taken off what you owe another.",
      "Set how many days each supplier gives you to pay; due dates follow it.",
    ],
  },

  // --------------------------------------------------------------- bookings
  {
    slug: "workshops",
    group: "bookings",
    title: "Set up a workshop and its dates",
    summary: "Create the workshop, add dates, and see who's coming.",
    steps: [
      "Open Bookings and add a workshop: its name, how long it runs and how many seats.",
      "Add dates one at a time, or repeat weekly.",
      "Share your booking page link, or sell it through your shop (see “Sell workshops through your Shopify shop”).",
      "Open a date to see its list: add someone by hand, move or cancel a booking, and tick people in on the day.",
    ],
    notes: [
      "Confirmation, reminder and thank-you emails are sent for you. Set their timing and wording in Bookings → Settings.",
      "A date can be closed to new bookings, or made private so only you can add people.",
      "A paid booking is never dropped. If a date was full when the payment landed, the person is booked and the date is flagged for you.",
    ],
  },
  {
    slug: "shop-bookings",
    group: "bookings",
    title: "Sell workshops through your Shopify shop",
    summary: "Shoppers pick a date on the product page and pay at your checkout.",
    steps: [
      "Open the workshop in Bookings and find “Sell this in your Shopify shop”.",
      "Choose the product that sells it and save.",
      "Copy the snippet shown and paste it into your theme's product page, in a “Custom liquid” block above the buy button. One paste covers every workshop product.",
      "In Shopify, turn “Track quantity” off for the product: the seats here are the limit.",
    ],
    notes: [
      "Your shop sets the price and takes the payment, so no payment setup is needed in the suite.",
      "The order arrives as a booking within moments. Refunds and cancellations in your shop free the seats here.",
      "A workshop sold this way can't also be booked on the suite's own booking page.",
    ],
  },

  // ----------------------------------------------------------------- social
  {
    slug: "assets",
    group: "social",
    title: "Keep your photos and videos in Assets",
    summary: "Upload, sort into folders, and tag so the right picture is found.",
    steps: [
      "Open Social → Assets and drop in photos (JPEG or PNG) and videos (MP4 or MOV).",
      "Make folders for the way you work. Tick several files to move, tag or put them away together.",
      "Open a file to name it, tag it and attach it to a project.",
      "Press “Bring in product photos from your shop” to copy each product's main photo in, already tagged.",
    ],
    notes: [
      "Tags do real work: when Claude drafts a post or email, a photo whose tags match the topic is attached for you.",
      "Tag your logo “logo”, and a light version “logo-light”, and emails use them.",
      "Putting a file away hides it without breaking posts that used it.",
    ],
  },
  {
    slug: "write-a-post",
    group: "social",
    title: "Write and schedule a post",
    summary: "Caption, photos or a video, and when it goes out.",
    steps: [
      "Open Social and start a new post.",
      "Write the caption, or say what it's about and press “Draft with Claude”.",
      "Pick photos from Assets, or one video. A video goes out on its own, as a Reel on Instagram.",
      "Choose Facebook, Instagram or both, then save as a draft, schedule it, or post now.",
    ],
    notes: [
      "Nothing Claude drafts is ever posted by itself. A draft stays a draft until you schedule it.",
      "You can write different words for each channel.",
      "Instagram posts need a photo or video, and photos must be JPEGs.",
      "“Draft the month” fills your open posting times with drafts for you to review.",
    ],
  },
  {
    slug: "design-an-image",
    group: "social",
    title: "Design a picture in your brand",
    summary: "Words on a colour or a photo, for posts and email banners.",
    steps: [
      "In a new post, press “Design an image”. In an email, add or open a banner.",
      "Pick a layout and one of your brand colours. Click any text to change it, and drag to move it.",
      "Add a photo from Assets if you want one behind or beside the words.",
      "Save. The picture is added to your post or email, and kept in Assets.",
    ],
    notes: [
      "A designed picture stays editable: press “Edit design” to reopen it.",
      "Layouts on offer depend on the overall feel you chose in your brand kit.",
    ],
  },
  {
    slug: "emails",
    group: "social",
    title: "Design a marketing email",
    summary: "Start from a template or let Claude write a first draft.",
    steps: [
      "Open Social → Emails.",
      "Describe the email and press “Write a first draft”, or pick a starter template. Both open in the builder in your colours.",
      "Drag blocks to rearrange them, click text to edit it, and use Styles to change the look.",
      "Open Preview to see it on a computer and a phone, and to read the “before you send” list.",
      "Press “Copy HTML” and paste it into the tool you send email with.",
    ],
    notes: [
      "The suite designs the email; it doesn't send it. Your own email tool does that.",
      "Give Claude the facts: dates, prices, codes. Anything it wasn't told is left as a gap [like this] for you to fill in.",
      "The builder needs a wide screen, so use a computer.",
    ],
  },

  // ------------------------------------------------------------------ money
  {
    slug: "money",
    group: "money",
    title: "Read your Money page",
    summary: "Sales, margins and cash, from your shop and your books.",
    steps: [
      "Connect your shop for sales, and your accounting software for cash and costs.",
      "Open Money. Charts show sales over time, your best sellers, and where orders come from.",
      "Change the date range at the top. Every chart can also be shown as a table.",
      "Owners and admins can rearrange the page, or ask the Assistant to suggest a layout.",
    ],
    notes: [
      "Figures come from what your shop reports. Cancelled and test orders are left out of sales.",
      "Home shows this week's sales at a glance.",
    ],
  },

  // ------------------------------------------------------------------- team
  {
    slug: "invite-team",
    group: "team",
    title: "Invite your team",
    summary: "Add people and choose what they can change.",
    steps: [
      "Open Settings → Team and invite someone by email.",
      "Choose their role. Members do the daily work; admins can also change settings; owners can manage billing.",
      "They get a link to join. Until they accept, the invite shows as waiting.",
    ],
    notes: [
      "Members can pack orders, answer customers, check in deliveries and write posts.",
      "Suppliers, orders to suppliers, what you owe, and settings are for owners and admins.",
    ],
  },
  {
    slug: "messages",
    group: "team",
    title: "Talk to your team in Messages",
    summary: "Channels for everyone, direct messages for two.",
    steps: [
      "Open Messages. Channels are open to the whole workspace.",
      "Start a direct message for a conversation between you and one other person.",
      "Other tools post heads-ups here, such as a new booking or a post that failed to send.",
    ],
    notes: [
      "You can edit or delete your own messages. The number in the menu is what you haven't read.",
    ],
  },
  {
    slug: "assistant",
    group: "team",
    title: "What the Assistant can do",
    summary: "Ask questions about your business and have it suggest changes.",
    steps: [
      "Open Assistant and ask in your own words, for example “what sold best last month?”",
      "Ask it to change a setting, such as your reminder timing or your dashboard layout.",
      "It shows you the change it suggests. An owner or admin previews it and presses Apply.",
    ],
    notes: [
      "The Assistant never changes anything by itself, and never sends anything to your customers.",
      "It only sees what you could see yourself.",
    ],
  },

  // ---------------------------------------------------------------- account
  {
    slug: "plans",
    group: "account",
    title: "Plans, the free trial and billing",
    summary: "Start free, choose a plan, change or cancel any time.",
    steps: [
      "Every workspace starts with a free trial.",
      "Open Settings → Billing to choose a plan or change it. Payment is handled by Stripe.",
      "Tools that aren't on your plan show a lock in the menu.",
    ],
    notes: [
      "If a plan ends, your workspace becomes read-only: you can see everything but not change it.",
      "After you leave, your data is kept for a while in case you change your mind, then removed.",
    ],
  },
  {
    slug: "privacy",
    group: "account",
    title: "Your data and your customers' data",
    summary: "What's kept, who can see it, and what Claude does with it.",
    steps: [
      "Each workspace's data is kept apart from every other's.",
      "Passwords and keys for your connected services are stored encrypted and never shown again.",
      "When a shopper asks your shop to be forgotten, their name and address are removed here too, while your sales figures stay.",
    ],
    notes: [
      "Claude drafts are suggestions for you to edit. They are never sent or posted without you.",
      "Disconnecting a service removes the suite's access to it.",
    ],
  },
];

export const topicBySlug = (slug: string) =>
  HELP_TOPICS.find((topic) => topic.slug === slug) ?? null;
