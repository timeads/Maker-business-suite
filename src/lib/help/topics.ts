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
      "Open Settings → Look.",
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
    slug: "getting-around",
    group: "start",
    title: "Find your way around",
    summary: "Your tools down the side, and each tool's own menu beside them.",
    intro:
      "Two things sit to the left of every page: a slim strip with one icon per tool, which never changes, and beside it the menu of the tool you're in.",
    steps: [
      "Press an icon on the strip to open a tool. Rest the pointer on an icon to see its name. The tool you're in is marked in ochre, and a small number means something is waiting there.",
      "The menu beside the strip lists that tool's places: Shipping's To ship, All orders and Scan & pack; Stock's To order, Everything and Suppliers; the help desk's folders and tags. The place you're in is shaded, and a number beside a place is how many things are in it.",
      "“Settings” at the foot of a tool's menu opens that tool's part of Settings. Each settings page has a “Back to” link at the top that returns you to the tool.",
      "To give a page more room, press the small button at the top of the menu to fold it away. The same button then appears beside the page's title to bring it back. Your browser remembers which you chose.",
      "Your workspace's initials at the top of the strip switch between workspaces. Help, and your own initial with “Sign out”, are at the bottom.",
    ],
    notes: [
      "On a narrower window the menu folds away by itself; press the button beside the page's title to open it over the page. Escape, or a press outside it, closes it.",
      "On a phone your tools are along the bottom, and the same button beside the title opens the tool's menu.",
      "Home and the email builder have no menu of their own.",
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
      "Your tools sit along the bottom on a phone, with the rest behind “More”. The button beside a page's title opens the menu of the tool you're in.",
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
      "Each workspace has one support address, shown under Settings → Help desk. Mail sent to it becomes a conversation in your inbox.",
    steps: [
      "Open Settings → Help desk (“Settings” at the foot of the help desk's menu goes straight there) and copy your support address.",
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
    summary: "Reply, forward, use a saved reply, or let Claude draft one for you to edit.",
    steps: [
      "Open a conversation from the list. The conversation is in the middle, with the reply box under it; who the customer is and what they ordered is on the right.",
      "Write your reply. The bar above the box gives bold, italic, underline, strike, lists and links. “Macros” drops in a saved reply, “Attach” adds files (4 MB together at most), and “AI” asks Claude for a first draft; you can tell it what to say.",
      "“Reply all” and “Forward” are tabs above the box. “Reply all” copies in everyone else the customer wrote to. “Forward” takes the conversation's pictures and files along; take off any you don't want to pass on. “Edit” beside the address lets you change who it goes to and add Cc or Bcc.",
      "Press “Send & close” when that's the end of it. “Send” keeps the conversation as in progress, and the arrow beside it can keep it open or snooze it until later.",
      "For a few seconds after sending, “Undo” at the foot of the page takes the email back and puts your words in the box again. How long is set under Settings → Help desk.",
      "“Internal note” is for your team only. Type @ and pick a teammate to get their attention.",
    ],
    notes: [
      "A draft from Claude only fills the reply box. It is never sent unless you press Send.",
      "A sent email still goes if you close the page before the undo time is up; only “Undo” stops it.",
      "A saved reply can also do something when it is sent, like add a tag or close the conversation. You'll see it under the box as “On send”, and can take it off.",
      "What you were writing is kept in this browser until you send it or press the bin. It isn't on your other devices.",
      "Notes are for your team only and are never emailed.",
      "Shortcuts: j and k move through the list, r replies, n writes a note, f forwards, e closes, and ? shows them all.",
    ],
  },
  {
    slug: "desk-files",
    group: "helpdesk",
    title: "Pictures and files in a conversation",
    summary: "What customers send is kept with the conversation; so is what you send.",
    steps: [
      "A picture a customer set into their email shows where they put it. Other pictures show as small pictures under the message, and other files as a chip with the name and size.",
      "Press a picture or a video to see it large. A PDF opens in a new tab; anything else downloads.",
      "Files you attach to a reply are kept the same way, so the conversation shows what was sent.",
    ],
    notes: [
      "We keep photos (JPEG, PNG, GIF, WebP, HEIC), PDFs, MP4 and MOV videos, and plain text and CSV files. Anything else is listed as “a file we didn't keep” with its name, kind and size; ask the customer for a photo or a PDF instead.",
      "A file can be up to 25 MB, an email's files 35 MB together, and a workspace keeps up to 500 MB a day.",
      "An iPhone HEIC photo shows as a picture where the browser can draw it (Safari), and as a download elsewhere.",
      "Files are private to your team. When a conversation is deleted for good, or a customer asks to be forgotten, its files go too.",
    ],
  },
  {
    slug: "desk-tidy",
    group: "helpdesk",
    title: "Archive, Spam and Trash, and doing several at once",
    summary: "Clear what you don't need to answer, one conversation or many.",
    steps: [
      "The ⋯ menu at the top of a conversation has Archive, Mark as spam and Delete. Each takes it out of your working folders and puts it under “More” in the menu.",
      "Archived is for things that are done. If the customer writes again it comes back to the inbox by itself.",
      "Spam and Trash stay where they are even if more mail arrives on them. “Not spam” or “Restore” brings one back as open.",
      "To act on several at once, tick the box on each row (or “tick all”). A bar under the list can close, assign, move to a folder, snooze, tag, archive, mark as spam or delete them together.",
    ],
    notes: [
      "Nothing empties the Trash by itself. Owners and admins can delete one conversation for good from its ⋯ menu, or press “Empty Trash”. That removes its emails, notes and files and can't be undone.",
      "Owners and admins can download the list as a spreadsheet with the arrow above it: who, the subject, status, tags and dates, without the words of any message.",
      "A new email from someone whose earlier message you marked as spam still arrives as a new conversation.",
    ],
  },
  {
    slug: "desk-details",
    group: "helpdesk",
    title: "See who you're writing to",
    summary: "The details beside a conversation: the ticket, the customer and their orders.",
    steps: [
      "“Ticket” at the top: change who has it, how urgent it is, its folder and its tags right there.",
      "“AI insights”: press Summarize for a few lines on what the customer wants, their mood and the kind of request. It is for your team only and counts against your plan's AI allowance.",
      "“Customer”: their orders, what they've spent in all and their last order, from your connected shop. “View on Shopify” opens their page in your shop.",
      "Each order shows what was in it, where it's going and its tracking if the parcel was sent from Shipping. “Add to reply” puts the order's details into your reply; “Label” opens it in Shipping when it still has to go.",
      "The Activity tab lists everything that happened to the conversation: mail in and out, notes, who took it, tags added or taken off (by a person or by one of your rules), and when it was closed.",
    ],
    notes: [
      "Orders are matched by the customer's email address. Someone who ordered under a different address won't be found.",
      "On a narrow window the details open from the “Details” button at the top of the conversation.",
      "If you use Stock, “Back in stock?” says which of the things they bought are sold out or have more on the way.",
    ],
  },
  {
    slug: "desk-folders-views",
    group: "helpdesk",
    title: "Folders and saved views",
    summary: "File conversations that are waiting on something, and keep the filters you use.",
    steps: [
      "A folder is somewhere to put a conversation that isn't finished but isn't for today, like a repair waiting on a part. Owners and admins make folders with the “+” beside Folders in the help desk's menu.",
      "File a conversation from “Folder” in its details, or from the ⋯ menu at the top. It leaves Open, Your tickets and the other inbox views and stays in its folder until it is closed or moved back.",
      "The filter button above the list narrows it by tag, person, priority or unread, and changes the order.",
      "Owners and admins can keep a set of filters as a view with “Save as view”, or make one under Settings → Help desk. Views show in the menu for the whole team.",
    ],
    notes: [
      "A dot beside a conversation means the customer has written since you last opened it. The dot is yours alone: your teammates have their own.",
      "Mentions lists the conversations where a note names you.",
      "Searching looks through names, addresses, subjects and what was said, in every folder.",
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
      "With an undo time set, the email is sent a few seconds after you press Send, so a problem shows as a red notice at the foot of the conversation instead. “Put the words back in the box” lets you try again.",
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
      "Use the views along the top for pickup orders, priority shipping, orders that need a signature, payment pending, on hold and international.",
      "Each line shows the order's age, how many items are left to send, the weight, the box it would go in, what your customer chose and paid, the best label price found for it with your margin, and where it's going.",
      "Open an order to see what to pack. Record the parcel with its carrier and tracking number, or buy a label (see “Buy a postage label”).",
      "Sending only part of an order? Press “Ship part of this order”, say how many of each item are going now, and buy a label for just those (see “Buy a postage label”). To record a part you posted some other way, use “Record by hand”.",
    ],
    notes: [
      "Put an order on hold with the “Hold” button under its summary: add a note and, if you like, the day it should come back. It returns marked “Back from hold”.",
      "If your settings say so (Settings → Shipping), recording a parcel also marks the order as sent in your shop, and your shop emails the customer their tracking.",
      "The number beside Shipping in the menu is how many orders are ready to go.",
      "“Best quote · margin” is worked out a few orders at a time after the list opens and kept for 12 hours or until the order changes. It is for the box under “Box”: what you set up on the order (“your choice”), a rule's box (“by rule”), the way you packed those items last time (“remembered”), or else your usual box. “By rule” beside a price means it is the service a rule asks for rather than simply the cheapest.",
      "Tick two or more orders to buy all their labels in one go (see “Buy labels for several orders at once”).",
      "“Address found” or “Address not found” under the town is what the carriers' address book said. Each address is asked about once.",
      "“Needs signature” lists orders your rules, or the signature amount under Settings → Shipping, ask a signature for.",
      "An order a rule holds shows under “On hold” with the rule's note. Release it and no rule will hold it again.",
      "“Refresh” reads the list again. The chip at the top right shows how this computer prints and opens the setting.",
    ],
  },
  {
    slug: "packing-slips",
    group: "shipping",
    title: "Packing slips and Scan & pack",
    summary: "Print slips your way, then scan items as you pack.",
    steps: [
      "Under Settings → Shipping → Packing slip, design the slip: your logo and address at the top, what prints and in what order, what each item shows, and a thank-you message. The preview beside it is the slip itself, redrawn as you change things; what you see is what prints, on paper and on a Zebra.",
      "Your logo is the picture tagged “logo” in Assets. A plain dark logo on white prints best, because thermal printers have no grey. Without one, your name prints instead.",
      "Tick orders in “To ship” and press “Packing slips” to print them.",
      "Open Scan & pack and scan a slip's barcode, or type the order number.",
      "Scan each item's code as it goes in the box.",
      "Under the items you'll see the box, weight and service your To ship list planned for that order, with a price asked just then. When everything is checked, press “Verify & print label”, stick it on, and scan the next slip.",
    ],
    notes: [
      "Buying at the bench takes the same care as buying on the order: a fresh price, one label per order however many times it's pressed, and the parcel recorded for you. On a computer set to a Zebra the label prints by itself.",
      "Some orders need a look first: no box or weight yet, an address the carriers don't know, part already sent, unpaid, going abroad. The bench says why and links to the order. Orders going out together are packed and bought as one, right at the bench.",
      "Want a different service or address? “Open label builder” opens the order. Bought the postage somewhere else? “Record a parcel by hand” is still there.",
      "A slip's barcode is the order's number without the “#” (68762-TG). An order planned in several boxes gets a slip for each box instead, listing just what goes in that box, saying “Box 2 of 3”, with a barcode that ends in the box (68762-TG/B2). Which items go in which box comes from the order's page, a rule, or how you packed the same items last time.",
      "Scan a box's slip and the bench lists and checks only that box. When it's checked, “Buy 3 labels & print box 1” buys the labels for every box at once and prints only that box's. Scan the next box's slip, check it, and print its label. The bench shows which boxes are packed and which labels are printed.",
      "After the labels are bought, each box's slip can be printed again with its own tracking number: open the order and press “Slip for each box” beside the parcel.",
      "An older slip for the whole order still works: it packs the order as a whole, and the labels for every box print together.",
      "Orders going out together share one slip. Its barcode is their numbers joined with “+” (1042+1055). Scanning it puts every order's items on the bench, each line saying which order it's from, and one label is bought for them all.",
      "Scanners sometimes swap the “/” for “-”, “?” or a space. The bench reads all of those as the same box.",
      "With an order open, scanning another slip opens that one instead; anything else is taken as an item.",
      "A wrong scan is called out straight away, so the wrong item doesn't go out. An item that belongs in another box is said to be exactly that.",
      "No scanner? Press the plus to count one, the count to fill a line, the round tick to fill or clear it, or “Mark all packed”.",
      "Under the items is the box the order is planned in, with its price asked as the order opens. Change the box or type a weight right there and the price follows; that choice is kept for the order. If the shop has no weight for the items, type one: “Enter the weight to print”.",
      "Packing and it won't fit? “Split into boxes” (or “Change boxes”) under the items lets you add a box, remove one, pick each box's size and say how many of each item goes in each, right at the bench. What you've scanned so far is kept. The new boxes are saved for the order, so its page and the To ship list show them too, and you're offered the slips again, because each box's slip and barcode follow the new split. Once the labels are bought the boxes are fixed.",
      "“Print label anyway” buys before everything is checked, after asking. “Ship what's scanned” sends only what you've scanned so far: you see the price for just those items, then choose whether the rest goes back to To ship for another box today, or waits on hold until it's in stock.",
      "Tick “Print the label as soon as every item is scanned” and the scan that finishes an order buys the label at the price on screen and prints it, with no button to press. The tick is kept on that computer only. Counts filled in by hand don't set it off, and an order on hold, unpaid or missing a weight always waits for you.",
      "The bench says why an order can't go yet: it already has a label, it's on hold (with “Release hold”), or payment is pending (with “Ship before payment”, for invoiced orders).",
      "Slips printed through the browser come on a 4 × 6 label or a letter page: choose on the slips page, per computer.",
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
      "Under Settings → Shipping → Ship-from & boxes, fill in where you ship from (street, city, state, postcode and phone) and add the boxes you pack in.",
      "Open an order. The address is checked for you, and the order starts in the box your rules or your past packing say (else your usual box). If the weight is known, the rates are already waiting.",
      "Fix the address if it needs it (the change is for this label only), pick the box, check its weight (one box, in pounds: 12.6 is twelve pounds and about ten ounces), and choose whether a signature is needed. Then press “Get rates” if they aren't showing.",
      "Choose a service. The list is cheapest first, and a small tag on each price says where the label would be bought: “via EasyPost”, “your UPS account” or “via Redo”.",
      "Press “Buy & print label”, or Ctrl+P. The label opens to print, and the parcel and tracking number are recorded for you.",
    ],
    notes: [
      "With more than one box, say what goes in each: a Box 1 / Box 2 switch for a single item, a count per box for several, or “Split evenly”. Where your shop has product weights, each box's weight follows what's in it.",
      "Each rate shows its margin: the shipping your customer paid, less the label. It turns red when a label costs more than they were charged. “Customer's choice” marks the service that matches what they picked at checkout, when that's clear.",
      "When the same service is on offer from more than one account, you see it once, at the cheapest, with what the others would charge underneath.",
      "If one account can't be reached, its prices are left out and a line under the list says so. The rest still work.",
      "Under Settings → Shipping you can ask for a signature on every order over an amount (Ship-from & boxes), and write rules that pick the box, the signature, the service or a hold for you (see “Shipping rules”). “Rules applied” above the address lists the ones that matched; “By rule” marks the service a rule chose. Whatever you change on the order yourself wins.",
      "What you set up on an order (boxes, weights, which items go where, the signature, the service) is saved as you go, so you can set it up at a desk and buy it at the packing computer. “Your saved choices · Reset” in the Items & boxes header goes back to the plan. A change to the address is for the label on screen only and isn't saved.",
      "After you buy a label for a whole order, its boxes, split and weights are remembered for those items. The next order with the same things opens packed the same way and says so, with “Use the usual box” beside it. Switch this off, or forget one packing, under Settings → Shipping → Rules → Remember how I pack.",
      "Use the arrows at the top (or J and K) to go to the next order without going back to the list.",
      "Some items not ready? Press “Ship part of this order” in the Items & boxes header and say how many of each are going now. The page lays out the box, weight and rates for just those, and the label you buy records only them. Your shop is told about just those items.",
      "After a part shipment, what's left goes on hold with a note saying what it's waiting on (“Part sent — waiting on: …”). Release it when it can go, then buy its label the usual way. Untick “Hold what's left” before buying if the rest is going later the same day. A part shipment isn't remembered as how you pack those items.",
      "An order can go in several boxes. Press “Add another box”, weigh each one, and you buy them together: one label and tracking number per box, all on the same parcel.",
      "International labels need a customs form, which isn't built yet. Buy those elsewhere and record the parcel by hand.",
      "Owners and admins can void a label. That asks whoever sold it (EasyPost, UPS or Redo) to cancel it and puts the items back in the queue. If your shop was told the parcel went, the order is marked unfulfilled there again, so you can send it another way. The order page and the Sent list say how that went: “Marked unfulfilled in your shop”, or “Couldn't undo it in your shop: do that there”.",
      "Before you void, the question says whether your customer was already emailed that tracking number. They aren't emailed again about the change, so drop them a line if it matters.",
      "The suite won't buy the same label twice, even on a double press.",
      "Got a Zebra thermal printer at the packing bench? Labels can go straight to it with no print window. See “Print labels straight to a Zebra printer”.",
    ],
  },
  {
    slug: "shipping-rules",
    group: "shipping",
    title: "Shipping rules",
    summary:
      "Let the app pick the box, the signature, the service or a hold for orders that look a certain way.",
    intro:
      "A rule says “when an order looks like this, do that”. Rules are worked out for every waiting order, so the To ship list and each order's page already show the right box, signature and service. Owners and admins set them up under Settings → Shipping → Rules.",
    steps: [
      "Open Settings → Shipping → Rules. Press “Add a rule” and give it a name you'll recognise, like “Machines need a signature”.",
      "Say when it applies. Add one or more conditions: how many items are in the order, the order total, product names, item codes (SKUs), the state or country it's going to, or the shipping your customer chose. Every condition has to be true.",
      "Say what it does. Tick any of: pack it in a box from your list, ask for a signature (or an adult's), send it by the cheapest service, the fastest, or one you name (like “UPS Ground”), or put it on hold with a note.",
      "Press “Save rule”. It applies to waiting orders straight away.",
      "Put your rules in order with the arrows. When two rules would both pick a box for the same order, the higher one wins; the same goes for the signature, the service and a hold, each on its own.",
    ],
    notes: [
      "Several names or codes go in one box with commas between them. “Includes any of” matches an item that is, or contains, one of them.",
      "Amounts can be typed as 250, $250 or 1,000. “More than 250” does not include an order of exactly 250.",
      "Switch a rule off with its tick to keep it without using it. “Edit” changes it; the bin deletes it.",
      "“Ask for a signature on orders of at least…” under “When you buy a label” still works as it always has. It shows at the bottom of the list as a built-in rule and comes after your own, so one of yours can ask for an adult signature instead.",
      "On an order, “Rules applied” lists every rule that did something. What you choose on the order yourself always comes first, including “No signature”.",
      "A named service that no carrier offers for an order falls back to the cheapest.",
      "A rule that puts orders on hold holds each matching order once, with the rule's note. If you release one, it stays released.",
      "A rule's box comes before the packing remembered from last time; your own saved choice on an order comes before both.",
      "You can ask the assistant to draft a rule for you. It proposes the change; an owner or admin looks it over and applies it.",
    ],
  },
  {
    slug: "bulk-labels",
    group: "shipping",
    title: "Buy labels for several orders at once",
    summary: "Tick the orders, check the total, and buy every label in one run.",
    intro:
      "When the list already shows the right box and a price for each order, you don't need to open them one by one. A run buys each label on its own, one after another, so one that can't be bought never stops the rest, and nothing is ever bought twice.",
    steps: [
      "Open Shipping and wait a moment for the Box and “Best quote” columns to fill in.",
      "Tick two or more orders. The bar at the top shows “Buy N labels · about $X”: the list's best quotes added up.",
      "Press it to see what will happen, including any ticked orders that will be left out and why. Then press “Yes, buy N labels”.",
      "Watch the run. Each order shows as bought (with its service and price), skipped (with the reason) or “needs a look”.",
      "On a computer set up for a Zebra, each label prints as it's bought, in the same order. Anywhere else, open each label from the run to print it.",
    ],
    notes: [
      "Each label is bought with the box, weight, signature and service the list shows for that order: your saved choices first, then a rule's, then what was remembered, then your usual box and the cheapest service.",
      "Every price is asked for again as the label is bought. If it has gone up by much since the list worked it out, that order is skipped so you can look at it.",
      "Left out of a run: orders on hold, pickups, international orders, unpaid orders, orders that are partly sent, orders with a label already under way, orders that could ship together with another (use “Ship together” for those, or say “Not now”), orders with no weight or box, and orders whose address the carriers don't know.",
      "“Needs a look” means we couldn't tell whether a label was bought, or it was bought but not recorded. Open the order: it is under “Labels to finish”, exactly as when buying one label. Don't buy it again until then.",
      "Marking orders fulfilled in your shop, and emailing customers their tracking, follow your settings under Settings → Shipping.",
      "One run buys up to 25 labels. Keep the page open until it finishes; if you leave, the orders not yet reached are simply not bought.",
      "Every run is kept under Shipping → Label batches: who ran it, what was bought and what it cost, what was skipped, and a button to print all its labels again.",
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
      "In the same browser you use for the suite, open localhost:9101/ssl_support once and accept it. That lets this site talk to Browser Print.",
      "On that computer, open Settings → Shipping → Printing on this computer (“Settings” at the foot of Shipping's menu gets you there). Press “Look for a Zebra on this computer”. If Chrome asks whether this site may reach devices or apps on this computer, choose Allow.",
      "When it finds your printer, the computer is switched to it. Pick yours if there's more than one. Most Zebras are 203 dpi; change that only if yours is a 300 dpi model.",
      "Press “Print test label”. A small label with a barcode should come out.",
      "From then on, “Buy & print label” sends the label straight to the Zebra, and any packing slip button sends the slips there too. With several boxes, the labels come out in box order.",
    ],
    notes: [
      "Every computer starts out printing through the browser, and the choice is kept in that browser only. A new computer, a different browser, or a new web address for the suite all start again: look for the Zebra once on each.",
      "Not set up yet? Beside the print buttons you'll see “This computer prints through the browser. Print straight to a Zebra? Set it up”. That link goes straight to this setting.",
      "Through the browser, a label opens on its own page at exactly 4 × 6 inches and the print box comes up by itself. If your browser asks, choose margins: none and scale: 100%.",
      "If the printer can't be reached when you buy, the label is still bought and saved on the order. Nothing is bought twice. Fix the printer and press “Print again”, or open the label and print it the ordinary way.",
      "Every label remembers when it was last printed, on any computer. Before a second copy comes out you're asked first, because only one copy of a label can be used. Packing an order one box at a time at Scan & pack, each box's label is remembered on its own.",
      "You can print any label again later from the order's “Already sent” list.",
      "Labels bought on a Zebra computer are in the printer's own format. On another computer they open as a file rather than a picture, so reprint those from the packing bench.",
      "Labels bought as pictures (on another computer, or from Redo) are redrawn for the Zebra when you print them. So is a Redo label that arrives as a PDF: each page comes out as its own label. If one can't be drawn, the page says so, and you can open the label and print it the ordinary way.",
      "Packing slips go to the Zebra too, on the same 4 × 6 labels: “Packing slip” on an order, “Packing slips” for ticked orders and “Print these” on the slips page all print on one press, with no print box. A long order runs onto a second label. “Print on paper” is still there on the slips page.",
      "Slips that went to the Zebra are marked as printed by themselves. If some were printed before, you're asked first: print only the new ones, print them all again, or cancel.",
      "Nothing printing? Press “Check the connection” in the same settings: it says whether Browser Print answers, which printer it sees, and whether the printer is paused, open or out of labels. “Reset printer” clears a stuck or half-sent label and takes the printer out of pause.",
      "“Chrome is blocking this site”? Click the icon at the left of the address bar, open Site settings, and set “Local network access” (some versions call it “Apps on device”) to Allow, then reload the page.",
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
      "What your customer paid for shipping is added up across the orders, so each rate's margin is the real one. A signature rule looks at the orders' combined total too.",
      "If your shop is told when parcels go, each order is marked as sent there, so your customer gets one email per order with the same tracking.",
      "Voiding the label (owners and admins) undoes every order in the parcel at once.",
      "Sending part of an order and putting orders on hold aren't offered while orders are open together. Open one on its own for those.",
    ],
  },
  {
    slug: "pickup",
    group: "shipping",
    title: "Orders the customer collects",
    summary: "Mark a pickup order ready, then collected. Your shop is told both times.",
    steps: [
      "Open the “In-store pickup” view in Shipping.",
      "When the order is packed, press “Mark ready for pickup”. Your shop is told, and it emails the customer to come and collect.",
      "When the customer has it, open the order and press “Mark picked up”. It leaves the queue, and your shop shows the order as fulfilled.",
    ],
    notes: [
      "Telling your shop is the “Tell my shop about pickups” setting under Settings → Shipping → Ship-from & boxes. It's on unless you switch it off. Switched off, the steps are kept in the suite only.",
      "The order says how it went: “Telling your shop…”, then that your shop was told, or that it couldn't be and what to do there instead.",
      "If your shop is connected watch-only (or hasn't given permission to change orders), the buttons still keep the suite's own record and the page says plainly that your shop wasn't told. Do the step in your shop too.",
      "Owners and admins can step a pickup back. A “ready” email your shop has already sent can't be taken back, and the customer isn't emailed a second time if you mark it ready again.",
    ],
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
      "“Order by” is that date, less the supplier's lead time and a small buffer you set under Settings → Stock.",
      "The suggested quantity covers the lead time plus the days of cover you want, plus any safety stock, less what you have and what's coming.",
      "Suggestions round up to whole cases, and respect the smallest order you or your supplier set.",
    ],
    notes: [
      "Lead time and days of cover come from the supplier unless an item has its own. A supplier whose lead time is left empty uses your usual figure from Settings → Stock.",
      "Once a supplier's orders have arrived, Stock → Suppliers shows how long they really take (“Observed”), with “Use” to make that the lead time.",
      "Days an item was sold out don't count against it: a day with none on the shelf isn't a day nobody wanted it. We note each item's count once a day from the day Stock is switched on, so this gets better with time.",
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
      "Under “Add an item” you can put anything you stock on the order, not only that supplier's things. Their own items are listed first; type a name or SKU to find the rest.",
      "Add shipping, tax or other amounts if you know them, then mark the order as sent when you place it.",
    ],
    notes: [
      "Items with no supplier, or whose supplier you no longer order from, are listed as left off, so nothing is dropped quietly.",
      "Owners and admins can open the order as a PDF to send to the supplier. You can also print it or download it as a spreadsheet.",
      "Lines stay editable until the order is closed, so it can match what really arrived.",
      "Each line's cost starts from what the item costs you: your own figure if you've typed one on the item's page, else the average of what your checked-in deliveries cost, else the cost in your shop. Change it on the line whenever the supplier's price is different.",
    ],
  },
  {
    slug: "reorder-list",
    group: "stock",
    title: "Read the reorder list, and save your own views of it",
    summary: "What each column on Stock → Everything means, and how to keep a view.",
    intro: "Stock → Everything lists every item your shop counts, the soonest to reorder first.",
    steps: [
      "“30D Sales” is what sold in the last 30 days. “30D Forecast” is what we expect in the next 30, allowing for your busy months.",
      "“Stock” is what's on the shelf. A green chip beside it, like “+ 30 (1 order)”, is what's on its way; press it to open the order.",
      "“Stock Out” is when you'd sell the last one, and “Reorder” is when to order by. Red means it will run out before a new order could arrive, or that the order is already late.",
      "“% Rev” is the item's share of everything your shop took in over the last 90 days.",
      "The tabs across the top are views: All, On Order, Dead Stock (nothing sold in 90 days, some still on the shelf), Hidden, and At-risk Top Sellers (your top fifth by revenue that need ordering within a week).",
      "Search by product, SKU or supplier. Press a column's name to sort by it. “Columns” shows or hides columns, including the suggested amount, cost and price.",
      "To keep a view, set the list up how you like it and press “+ Save view”. Give it a name, and tick “Open the list on this view” if it should be the first thing you see.",
    ],
    notes: [
      "Saved views are shared by the whole workspace. Owners and admins save them and take them off (the × beside the name); everyone can use them.",
      "The # is the item's place when the soonest reorder comes first. It stays with the item when you sort another way.",
      "“Export CSV” downloads the view with the columns on screen. Tick some rows first to export just those (up to 150 at a time).",
      "Photos come from your shop: the photo of that exact option when it has one, otherwise the product's.",
    ],
  },
  {
    slug: "order-pdf",
    group: "stock",
    title: "Send a supplier a purchase order as a PDF",
    summary: "A tidy document with your name, address and logo on it.",
    steps: [
      "Open the order under Stock → Orders and press “PDF”. It opens in a new tab; save it from there and attach it to your email.",
      "It carries your business name and address, the supplier and who you deal with there, the dates, every line with its codes and smallest order, and the totals.",
    ],
    notes: [
      "The PDF is for owners and admins, like placing the order itself.",
      "Your address is the one parcels are sent from, under Settings → Shipping → Ship-from & boxes.",
      "For your logo, upload it under Social → Assets and tag it “logo”. It needs to be a PNG or a JPEG.",
      "The contact and the supplier's email (one address, or several with commas) are on their row under Stock → Suppliers.",
      "Dates are shown on your own calendar, whatever timezone the supplier is in.",
      "You can also email the order straight from your own Gmail, with this PDF attached: see “Email an order to your supplier from your own Gmail”.",
      "A name written in Chinese, Japanese or Korean characters prints as written.",
    ],
  },
  {
    slug: "email-orders",
    group: "stock",
    title: "Email an order to your supplier from your own Gmail",
    summary:
      "Connect Gmail once, then send any order with its PDF attached. It lands in your own Sent folder.",
    intro:
      "Orders go out from your own address, so the supplier's reply comes back to you and the whole conversation stays in your Gmail.",
    steps: [
      "An owner or admin opens Connections and presses “Connect Gmail (to email orders)”. Google asks you to choose the mailbox and to allow sending email on your behalf. Leave that ticked and continue.",
      "Open an order under Stock → Orders. Under “Email this order” the supplier's addresses, a subject and a message are filled in for you. Change anything you like, and tick “Send a copy” if you want one.",
      "Press “Look it over”. You see who it goes to, the subject, the message and the attached PDF, exactly as they'll be sent.",
      "Press the send button. For a draft it reads “Send & mark ordered”: the order goes and is marked as ordered in one step.",
    ],
    notes: [
      "Unless you choose otherwise, the permission is only to send: we can't read, search or delete anything in your mailbox, and nothing is ever sent without someone pressing the button.",
      "Reading is a separate choice, for supplier balances only (see “Have bills file themselves from email”). If you never pick it, your mail is never read.",
      "Every send is noted on the order: when, who pressed, who it went to and from which mailbox.",
      "If you change an order after emailing it, the order says “Changed since you emailed it” and lists what changed. Sending again replies in the same conversation with the new PDF and says what's different.",
      "Pressing send twice sends once. If Gmail says no, nothing went and you can try again. If we never hear back from Gmail we say so and don't send again by ourselves: check your Sent folder first.",
      "If the supplier has no email saved, whoever you send to is saved as their contact for next time.",
      "Set the words every order email starts from under Settings → Stock → Order emails. You can use {{po_reference}}, {{supplier_name}}, {{contact_name}}, {{month}} and {{sender_name}}.",
      "To stop, press Disconnect on Gmail under Connections, or remove the app in your Google account's security settings. Either one ends it.",
      "Don't see Gmail under Connections? It hasn't been switched on for your suite yet. You can still download the PDF and send it yourself.",
    ],
  },
  {
    slug: "incoming-tracking",
    group: "stock",
    title: "Follow what's on its way from a supplier",
    summary: "Add tracking numbers to an order; UPS ones update by themselves.",
    steps: [
      "Open an order you've sent, under Stock → Orders, and add the tracking number the supplier gave you under “On its way”. An order can have several.",
      "If you've connected your own UPS account under Connections, UPS numbers (they start 1Z) are looked up for you every few hours: label made, on the way, out for delivery, delivered or held up, with the day UPS expects to deliver and where it was last scanned.",
      "Press “Check now” on a parcel to have UPS asked straight away. It takes a minute, and can be pressed once every ten minutes for a parcel.",
      "Open “Say what's in this parcel” to note which items, and how many, are in each one. It's a note for you: it doesn't check anything in.",
    ],
    notes: [
      "Got several numbers for one order? Paste them all into the box, one to a line. Each becomes its own parcel with the same carrier, date and label; one the order already has is left as it is.",
      "Every parcel still travelling also has a card on the Stock front page under “Parcels on the way”, with “It's here” and, for UPS, “Check now” and “Ask UPS about all of them”. The order-by-order view is under Incoming, and the green “on the way” chip on Stock → Everything says the same when you hover it.",
      "UPS's date takes the place of one you typed once UPS gives one. Your own “It's here” always stands.",
      "A delivered parcel still needs checking in: delivery doesn't change your counts.",
      "We stop asking once a parcel is delivered, once you mark it as here, when the order is closed, or after 45 days.",
      "“UPS doesn't know this number yet” is normal for a day or so after a label is made.",
      "If it says UPS won't share tracking, open your app at developer.ups.com and add “Tracking” under Products.",
      "A UPS connection set to practice labels isn't used for tracking: its answers are made up.",
      "Other carriers aren't looked up. Their numbers link to the carrier's own page and show what you record.",
    ],
  },
  {
    slug: "stock-import",
    group: "stock",
    title: "Bring your stock records in from spreadsheets",
    summary:
      "Suppliers, planning figures, past and open orders, supplier accounts and history, as CSV files.",
    intro:
      "Coming from another stock tool, or from spreadsheets? Owners and admins can bring records in under Settings → Stock → Bring your records across.",
    steps: [
      "Connect your shop first and let it sync: rows are matched to the items your shop has, by SKU, or by product and option where there is no SKU.",
      "Pick what's in the file, then the file. Bring them in this order: suppliers, item planning, purchase orders, past deliveries, supplier ledger, past daily counts.",
      "You're shown what it would do before anything is saved: how many are new, how many would change, how many are already as the file says, and each row left out, by line, with the reason.",
      "Press “Bring these in”. Fix any rows that were left out in the file and bring it in again whenever you like.",
    ],
    notes: [
      "The page lists the columns each file takes. The first line of a file names its columns; their order doesn't matter.",
      "Bringing the same file in twice changes nothing, and pressing the button twice only brings it in once.",
      "An order that says goods have already arrived, and a past delivery, are kept as history. They never raise a count here and are never sent to your shop. What is still to come on an open order is checked in as usual.",
      "An order whose reference is already here is left exactly as it is.",
      "A supplier chosen for an item in a file counts as chosen by hand: syncing with your shop won't change it.",
      "Past daily counts fill in the days before Stock was switched on, so sold-out days are known from the start. A day we already have a count for keeps it.",
      "A file can be up to 4 MB. The file itself isn't kept, only its name and what it came to.",
    ],
  },
  {
    slug: "suppliers",
    group: "stock",
    title: "Add and change your suppliers",
    summary: "One table of who you buy from. Type in a box and it saves.",
    intro:
      "Stock → Suppliers is a table with a row for each supplier. Owners and admins can change any box right where it sits; everyone else can read it.",
    steps: [
      "Press “Add supplier”. Only the name is needed; the rest can wait.",
      "Contact is the person you deal with there. Email is the supplier's email: purchase orders are sent there. Add more than one with commas between them; the first is the main address and the others get a copy.",
      "Lead time (d) is the days from ordering to having it on the shelf. Leave it empty to use your usual figure from Settings → Stock, shown in grey. A 0 is treated as empty.",
      "MOQ is the smallest order they'll take. “MOQ applies” says how it's counted: “Per order” across the whole order, or “Each SKU” for every item on it.",
      "To change anything later, type in the box and move on (or press Enter). A tick shows it saved; if something's wrong, the box says what.",
      "Observed (d) is how long their orders have really taken to arrive, with the number of orders that's worked out from in brackets. Press “Use” to make it the lead time.",
      "POs is how many orders they've had. Press the number to see them.",
      "The arrow beside a name opens the rest: how many days of sales one order should cover, when they're shut, days to pay, and notes.",
    ],
    notes: [
      "“Archive” is for a supplier you don't order from any more. We stop suggesting orders for their items; their orders and account are kept. They move to the Archived tab, where “Bring back” undoes it.",
      "A supplier can't be deleted, so nothing that leans on them is ever lost.",
      "To bring in many at once, use “Import suppliers (CSV)” under the table. You see what the file would change before anything is saved.",
      "On a phone the table slides sideways; the name stays put.",
    ],
  },
  {
    slug: "supplier-closures",
    group: "stock",
    title: "Plan around a supplier's holidays and shutdowns",
    summary:
      "Tell us when a supplier is shut and we'll move your order-by dates so orders arrive first.",
    intro:
      "Some suppliers shut for weeks at a time: a factory's month off at Spring Festival, a summer break. An order that would still be on its way when they shut needs placing earlier.",
    steps: [
      "Open Stock → Suppliers and press the arrow beside the supplier's name.",
      "Under “When they're shut”, give the closure a name and its first and last day, and press “Add closure”. Add as many as you need.",
      "From then on, the “Reorder” date of that supplier's items moves earlier whenever an order's days to arrive would run through a closure. The row is marked “Before Spring Festival” (hover it for the reason).",
      "On Stock → To order you'll see “Order before Spring Festival” with the last day to order, the items and how many of each. Press “Start this order” to draft it.",
    ],
    notes: [
      "That order is sized to last until the first order you could place after they reopen has arrived: the closure plus their days to arrive.",
      "If the last day to order has already gone by, we say so, and count an order placed now from the day they're back.",
      "Closures are dated, not yearly, because holidays like Spring Festival move. Add next year's when you know it.",
      "Two closures that touch are treated as one. If the gap between two is shorter than the days an order takes, the order has to go before both.",
      "Owners and admins add and remove closures; everyone on the team can see them.",
    ],
  },
  {
    slug: "dont-reorder",
    group: "stock",
    title: "Stop an item appearing in reorders",
    summary: "For gift cards, one-offs and anything you won't restock.",
    intro:
      "There are two switches. “Don't reorder” stops the suggestions but keeps the item in your lists, with its count. “Hide” takes it out of your lists altogether.",
    steps: [
      "For a line you're selling through: tick it on Stock → Everything and press “Don't reorder”. It stays in the list with a “You said don't reorder” label, and is never suggested or put on an order. Tick it again and press “Reorder again” to undo it.",
      "For things that were never stock (gift cards, made-to-order pieces): press “Hide” at the end of the row, or tick several and press “Hide”.",
      "Find hidden items under the “Hidden” view, where “Unhide” brings one back.",
      "Both switches are also on each item's own page.",
    ],
    notes: [
      "Under Settings → Stock you can list words that hide matching items automatically. It starts with “gift card”.",
      "You can also list tags there. Any product carrying one of those tags in your shop is left out after the next sync, and comes back when the tag is taken off.",
    ],
  },
  {
    slug: "change-planning-figures",
    group: "stock",
    title: "Change planning figures in the table",
    summary:
      "Days to arrive, cover, spare stock, smallest order, case size and cost, without opening each item.",
    intro: "Owners and admins can change an item's planning figures right on Stock → Everything.",
    steps: [
      "Press “Change figures” above the table. The planning columns turn into boxes.",
      "Type in a box and move on. It saves by itself, and “runs out”, “order by” and the suggestion catch up.",
      "To set the same figure on lots of items, tick them, open “Set figures for the ticked items”, fill in only the boxes you want to change and press Set.",
      "Press “Done changing” when you've finished.",
    ],
    notes: [
      "While “Change figures” is on, the Supplier column becomes a list to pick from, with a box under it for that supplier's own code for the item. Both save as soon as you change them.",
      "An empty box in the table goes back to the supplier's own figure, shown in grey.",
      "In the bar for ticked items an empty box means “leave it as it is”, so you can't wipe a figure by accident.",
      "A cost you type is your own figure for that item. Empty it and we go back to the average of your deliveries, or the cost in your shop.",
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
      "If you've switched it on under Settings → Stock, the arrived quantity is added to the count in your shop.",
      "When everything has arrived, the order closes by itself.",
    ],
    notes: [
      "The suite only ever adds what you checked in. It never lowers or overwrites your shop's count.",
      "Adding to the shop's count needs a shop with one stock location.",
      "Pressed the button twice? The delivery is still counted once.",
      "If your shop turns a delivery down, the order says why. Once that's sorted, an owner or admin can press “Try the shop again”. When we can't tell whether your shop took it, we don't send it again: check the count in your shop instead.",
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
      "The first page is everything at once: a card for the total and one per supplier, every open bill grouped by the week it's due, the ticked bills a payment has since cleared, and all the activity.",
      "Click a supplier's card (or their name anywhere) to open their account. Press “+ Add invoice or payment” there to add their invoices and your payments as they happen.",
      "When they send a statement, add its balance. That becomes the true figure on that date, and everything after it is added on.",
      "Tick “Paid” on a bill when you've sent the money. Add the payment itself when it has gone through.",
      "Click any invoice number to open that invoice: its dates, how much of it is paid and by which payments, who ticked it, and a place to correct or remove it.",
    ],
    notes: [
      "Typed an amount wrong? Add the invoice again with the same number and it's corrected, not counted twice.",
      "A credit with one supplier is never taken off what you owe another.",
      "Set how many days each supplier gives you to pay; due dates follow it.",
      "Four tiles show how late the money is: not due yet, 1–30 days late, 31–60, and 60+.",
      "A bill due on a Saturday or Sunday says “pay Fri …”: the Friday before.",
      "Payments count against the oldest bills first, so a payment meant for one invoice may show against an older one. A supplier's page lists which bills each payment cleared, and the balance after every entry.",
      "Narrow the bills and activity by supplier, type, dates or a search for an invoice number. The filters are in the page's address, so you can bookmark a view. Totals and cards always show everything.",
      "To fix an invoice's date or amount, open it and save a correction. Its number can't be changed: remove it and add it again.",
      "A payment dated in the few days before a statement may not be in that statement yet. We list it and don't take it off the balance, so nothing is counted twice; the supplier's next statement settles it.",
      "Tired of typing bills in? See “Have bills file themselves from email”. Entries read that way say “From email”, and any that were unclear are listed as “to check”.",
      "Press “Hide” on a notice to put it away. It stays hidden for everyone, on every device, until something about it changes; “Show them” brings hidden notices back.",
      "“Put these due dates on my calendar” downloads a calendar file with one entry per supplier per pay day (a weekend's bills go on the Friday before). Add it to your calendar; download it again later and the same entries update.",
    ],
  },
  {
    slug: "bills-by-email",
    group: "stock",
    title: "Have bills file themselves from email",
    summary:
      "Forward a supplier's invoices and statements to your bills address and they're filed on their account.",
    intro:
      "Settings → Stock → Balances & bills by email gives your workspace a private address. Forward a supplier's email to it and Claude reads it (and any PDF or picture attached) and files what it finds: an invoice, a statement's balance, a payment. Owners and admins set it up.",
    steps: [
      "Open Settings → Stock → Balances & bills by email (Stock → Balances has a link to it). Press “Switch on and get my address” and copy the address.",
      "Under “Who to recognise”, add each supplier's sender: pick the supplier and type the address (or just the domain) their bills come from. Save.",
      "Forward a bill to your address to try it. A minute or two later it's on that supplier's account, marked “From email”.",
      "To forward automatically from Gmail: add your bills address under Settings → Forwarding and POP/IMAP. Gmail sends a confirmation code to the address; it appears on that same settings page, and you type it into Gmail yourself. Then make a filter per supplier (From: their address → “Forward it to” your bills address).",
      "Look at the Balances page now and then: “to check” lists anything that was unclear, “Whose is this?” lists forwarded mail from a sender you haven't listed, and “Left out” says what wasn't filed and why.",
    ],
    notes: [
      "Any mail provider's forwarding works, and so does forwarding one email by hand.",
      "An entry marked “to check” already counts in your balance. Press “Looks right” if it is, open the invoice to correct it, or remove it. Something you remove stays removed, even if the same bill is emailed again.",
      "The same bill is only filed once, however many times it arrives. An invoice whose number is already on the account isn't added again; if the new copy has a different amount, the entry is marked to check.",
      "The supplier's latest statement always wins: anything dated on or before it is already in their figure, so it isn't filed again.",
      "What can't be read for certain is left out and listed with the reason (no total, no invoice number, an estimate, another currency), for you to type in.",
      "Your bank's payment notices can be filed as payments: add the bank's sender and, for each supplier, words the notice always carries (their name as the bank writes it, or the end of their account number). A notice about anyone else is never read.",
      "The email and its attachments aren't kept. We keep who sent it, when, its subject, and the figures read from it.",
      "Treat the address like a password. “Make a new address” gives you a fresh one and the old one stops working straight away.",
      "No address to hand? On a supplier's balance page, “+ Upload an invoice or statement” reads a PDF or picture the same way. The file isn't kept.",
      "Optional, where it's offered: instead of forwarding, you can let us read your Gmail once a day for mail from the senders you listed, and nothing else. It needs a wider permission from Google, so it's off unless you connect Gmail “with reading” and tick the box. “Try it” shows what would be filed from a sender's latest mail without filing anything.",
      "Up to 120 messages a day are read, with PDFs, PNGs and JPEGs up to 5 MB each. Reading uses your plan's monthly Claude allowance and pauses when that runs out.",
    ],
  },
  {
    slug: "payments-from-books",
    group: "stock",
    title: "Have payments to suppliers read from QuickBooks",
    summary: "Stop typing in payments you've already recorded in your books.",
    intro:
      "If QuickBooks is connected, Stock can read what you've paid your suppliers and add it to their accounts under Balances.",
    steps: [
      "Connect QuickBooks under Connections, if you haven't.",
      "Under Settings → Stock, tick “Read payments to my suppliers from QuickBooks” and save.",
      "From the next sync (a few times a day), bill payments, cheques and card charges made out to a supplier appear on that supplier's account, marked “from your books”.",
    ],
    notes: [
      "A payment is matched by name: the vendor in QuickBooks has to be spelled the same as the supplier in Stock (capitals don't matter).",
      "Only suppliers whose account you've started get payments, and only payments dated on or after their first invoice or statement.",
      "A payment you already typed in is left alone: the same amount within five days counts as the same payment.",
      "Change a payment in QuickBooks and the entry here follows. Take one off the account here and it stays off.",
      "Nothing is ever changed in your books. Until you tick the box, your books aren't read for payments at all.",
    ],
  },
  {
    slug: "seasons",
    group: "stock",
    title: "Plan ahead for a busy season",
    summary: "Say when you want stock on the shelf, and get an order-by date for each supplier.",
    steps: [
      "Under Settings → Stock → Seasons, add the season: a name, the day you want the stock in by, and a note if you like.",
      "On Stock → To order the season gets a card with the last day to order from each supplier. Items that take different times to arrive get their own line.",
      "Press “Draft an order” on a line to start that order, at today's suggested amounts.",
      "Expecting more than usual, for a sale or a fair your past sales don't know about? Give the season an extra lift in percent. Suggestions for that month go up by that much, and rows being bought into the busy month show a mark like “↑1.25×”.",
    ],
    notes: [
      "“Order by” is the in-stock day, less the days that supplier takes, less the days between your order reviews.",
      "Fold a card to one line, or put it away, with the buttons on it. That's kept for the whole workspace, on every device.",
      "The lift only counts while “plan for busy seasons” is on under Settings → Stock. A season whose day has passed no longer changes anything.",
      "This is separate from a supplier being shut: see “Plan around the days a supplier is shut”.",
    ],
  },
  {
    slug: "orders-list",
    group: "stock",
    title: "Find, rename, tidy and follow your orders",
    summary: "Views, search, a spreadsheet of the list, and each order's timeline.",
    steps: [
      "Stock → Orders opens on “In progress”. The other views are Draft, Overdue, All and Archived.",
      "Search by reference or supplier, or pick one supplier from the list. “Export CSV” downloads what's showing.",
      "The Shipping column says where an order's parcels are, from its tracking numbers: not shipped, shipped, some delivered, delivered or held up.",
      "Open an order and press “Rename” to give it a reference of your own. It's what your supplier sees on the PDF and the email.",
      "“What's happened” at the foot of an order lists everything in order: started, sent, each email, tracking added, each delivery and whether your shop took it, renamed, closed, with who did it.",
    ],
    notes: [
      "A draft you never used can be deleted for good. One that was emailed is kept: cancel it or put it away instead.",
      "“Put away (archive)” moves a draft or a finished order to the Archived view. An order still on its way is closed or cancelled first.",
      "No two orders can share a reference. A finished order keeps the one it had.",
      "On Stock → Suppliers each supplier shows how many orders they've had; press it to see just those.",
    ],
  },
  {
    slug: "michaels",
    group: "stock",
    title: "Sell on Michaels: connect, match your listings and watch",
    summary:
      "See how your Michaels listings line up with your shop, and what would be sent. For now it only watches.",
    intro:
      "If you sell on Michaels Marketplace, you can connect your seller account. The suite matches each Michaels listing to the item in your shop and shows what stock and prices it would send. For now it only watches: nothing is changed on Michaels or in your shop, so keep using whatever keeps Michaels up to date today.",
    steps: [
      "In the Michaels Developer Account Center, make an API key. Read Only access to Listing, Inventory, Price and Order is enough for now. Note the day you made it.",
      "Open Connections and find Michaels Marketplace. Paste the key, type the day it was made, choose the real marketplace (or the sandbox, if you're testing) and connect. We check the key with one small read.",
      "Open Settings → Stock → Michaels, tick “Look at Michaels” and save. The first look happens within a few minutes, then about once an hour.",
      "Open Listings. Each thing you sell on Michaels is matched to your shop by its seller SKU. “Needs a look” lists the ones that didn't match or are out of step.",
      "For a listing that didn't match, type the SKU it has in your shop and press “Pair”. A pairing you make by hand wins over the automatic matching, and “Take pairing off” undoes it.",
      "Open Would send to see every listing whose stock or price on Michaels differs from what your shop says it should be.",
      "Open Orders to see recent Michaels orders and what bringing each into your shop would make.",
    ],
    notes: [
      "Nothing is sent. Not stock, not prices, not orders, not tracking. Sending comes later, with its own switch and a cut-over time you choose.",
      "Stock would be your shop's count less the units held back (1 unless you change it under Settings → Stock → Michaels), never below zero. Prices would be exactly your shop's prices.",
      "Safety stop: if more than one listing in ten has no item in your shop, nothing could ever be sent until they're sorted out. You'll get a heads-up in Messages.",
      "Michaels ends every API key 90 days after it was made, and keys tend to misbehave in their last month. We count from the day you gave and remind you in Messages 14, 7, 3 and 1 days before the 60-day mark.",
      "To put in a new key: make it in the Developer Account Center, then under Connections disconnect Michaels Marketplace and connect again with the new key. Your pairings are kept.",
      "We keep an order's number, status, dates, totals and lines. We don't keep the buyer's name, phone or address.",
      "Anyone on the team can look. Only owners and admins can pair listings, change the settings or press “Look now”.",
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
      "Confirmation, reminder and thank-you emails are sent for you. Set their timing and wording under Settings → Bookings.",
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
      "Open Settings → People and invite someone by email.",
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
      "Open Settings → Plan & billing to choose a plan or change it. Payment is handled by Stripe.",
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
