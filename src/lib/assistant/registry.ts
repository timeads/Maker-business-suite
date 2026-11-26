import { z } from "zod";
import {
  BOOKINGS_MODULE,
  DEFAULT_EMAILS,
  EMAILS_KEY,
  DEFAULT_FORM,
  FORM_KEY,
  bookingEmailsSchema,
  bookingFormSchema,
} from "../bookings/config";
import { DEFAULT_SHOP_PAGE, SHOP_PAGE_KEY, shopPageSchema } from "../bookings/shop-page";
import { DAILY_KEY, DEFAULT_DAILY_EMAIL, dailyEmailSchema } from "../bookings/daily-config";
import { DEFAULT_SHOP_TAGS, SHOP_TAGS_KEY, shopTagsSchema } from "../bookings/shop-tags";
import { BUDGET_KEY, DEFAULT_BUDGET, budgetSettingsSchema } from "../bookings/budget";
import {
  DEFAULT_TEXT_SETTINGS,
  TEXTS_KEY,
  parseTextSettings,
  textSettingsSchema,
  textWordsChanged,
} from "../texts/config";
import { DEFAULT_UPCOMING, UPCOMING_KEY, upcomingSchema } from "../bookings/upcoming";
import {
  DEFAULT_EMAIL_WORDS,
  WORDS_KEY,
  emailWordsSchema,
  messageWordsChanged,
  type EmailWords,
} from "../bookings/words";
import { DASHBOARD_KEY, DASHBOARD_MODULE, dashboardSchema } from "../dashboard/schema";
import { DEFAULT_TEMPLATE, templateConfig } from "../dashboard/templates";
import {
  DEFAULT_RULES,
  DEFAULT_TEMPLATES,
  HELPDESK_MODULE,
  RULES_KEY,
  TEMPLATES_KEY,
  autoTagRulesSchema,
  replyTemplatesSchema,
} from "../helpdesk/config";
import {
  DEFAULT_SAVED_VIEWS as DEFAULT_DESK_VIEWS,
  SAVED_VIEWS_KEY as DESK_VIEWS_KEY,
  savedViewsSchema as deskViewsSchema,
} from "../helpdesk/saved-views";
import {
  DEFAULT_HELP_CENTRE,
  HELP_CENTRE_KEY,
  helpCentreConfigSchema,
} from "../helpdesk/help-centre/config";
import {
  AUTO_REPLIES_KEY,
  DEFAULT_AUTO_REPLIES,
  autoRepliesSchema,
  autoReplyWordsChanged,
  type AutoReplies,
} from "../helpdesk/auto-reply/config";
import { DEFAULT_MANUAL, MANUAL_KEY, manualConfigSchema } from "../helpdesk/manual/config";
import { DEFAULT_DESK_SETTINGS, DESK_SETTINGS_KEY, deskSettingsSchema } from "../helpdesk/settings";
import {
  CHANNELS_KEY,
  DEFAULT_CHANNEL_SETTINGS,
  channelSettingsSchema,
} from "../helpdesk/social/channels";
import { DEFAULT_TAG_GROUPS, TAG_GROUPS_KEY, tagGroupsSchema } from "../helpdesk/tag-groups";
import {
  DEFAULT_MICHAELS_SETTINGS,
  MICHAELS_MODULE,
  MICHAELS_SETTINGS_KEY,
  michaelsSettingsSchema,
} from "../michaels/config";
import type { ModuleKey } from "../modules";
import {
  DEFAULT_LINKS,
  DEFAULT_PLAN,
  LINKS_KEY,
  PLAN_KEY,
  SOCIAL_MODULE,
  WEEKDAY_NAMES,
  linkPageSchema,
  socialPlanSchema,
} from "../social/plan";
import {
  DEFAULT_REVIEW,
  REVIEW_KEY,
  approverWords,
  parseReview,
  reviewSettingsSchema,
} from "../social/review";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, appearanceSchema } from "../brand/appearance";
import { isKitKey } from "../brand/brands";
import { BRAND_MODULE, KIT_KEY, brandKitSchema } from "../brand/kit";
import {
  DEFAULT_SHIPPING_SETTINGS,
  DEFAULT_SLIP_LAYOUT,
  SHIPPING_MODULE,
  SHIPPING_SETTINGS_KEY,
  SLIP_LAYOUT_KEY,
  SLIP_SECTION_NAMES,
  shippingSettingsSchema,
  slipLayoutSchema,
} from "../shipping/config";
import { DEFAULT_SHIPPING_RULES, SHIPPING_RULES_KEY, shippingRulesSchema } from "../shipping/rules";
import {
  DEFAULT_HIDDEN_NOTICES,
  DEFAULT_SAVED_VIEWS,
  DEFAULT_SEASONS,
  DEFAULT_STOCK_SETTINGS,
  STOCK_HIDDEN_NOTICES_KEY,
  STOCK_MODULE,
  STOCK_SEASONS_KEY,
  STOCK_SETTINGS_KEY,
  STOCK_VIEWS_KEY,
  hiddenNoticesSchema,
  savedViewsSchema,
  seasonsSchema,
  stockSettingsSchema,
} from "../stock/config";
import {
  DEFAULT_EMAIL_SOURCES,
  STOCK_EMAIL_SOURCES_KEY,
  emailSourcesSchema,
} from "../stock/mail/config";
import { DEFAULT_PO_EMAIL, PO_EMAIL_KEY, poEmailSchema } from "../stock/po/email";

/**
 * Every setting the assistant may read or propose a change to. Anything not
 * listed here doesn't exist as far as it is concerned, and a proposal is only
 * filed once its body passes the same Zod schema the app reads it with.
 */
export type ConfigEntry = {
  module: string;
  key: string;
  /** The tool the setting belongs to, for plan checks. */
  feature: ModuleKey;
  name: string;
  description: string;
  schema: z.ZodType;
  defaultBody: () => unknown;
  /**
   * A rule a proposal must also pass, given the value saved now (both already
   * parsed by the schema). Returns why it is refused, or null. For settings
   * with a part only a person may write.
   */
  refuse?: (next: unknown, current: unknown) => string | null;
};

export const CONFIG_REGISTRY: readonly ConfigEntry[] = [
  {
    module: DASHBOARD_MODULE,
    key: DASHBOARD_KEY,
    feature: "dashboard",
    name: "Money dashboard",
    description:
      "Which charts and figures appear on the Money page, in what order and size, and the default date range.",
    schema: dashboardSchema,
    defaultBody: () => templateConfig(DEFAULT_TEMPLATE),
  },
  {
    module: HELPDESK_MODULE,
    key: TEMPLATES_KEY,
    feature: "helpdesk",
    name: "Help desk saved replies",
    description: "Reusable reply texts the team can drop into an email to a customer.",
    schema: replyTemplatesSchema,
    defaultBody: () => DEFAULT_TEMPLATES,
  },
  {
    module: HELPDESK_MODULE,
    key: RULES_KEY,
    feature: "helpdesk",
    name: "Help desk rules for new email",
    description:
      "Words to look for in incoming email, and what each match does: add a tag, set the priority (low, high, urgent), or both.",
    schema: autoTagRulesSchema,
    defaultBody: () => DEFAULT_RULES,
  },
  {
    module: HELPDESK_MODULE,
    key: DESK_VIEWS_KEY,
    feature: "helpdesk",
    name: "Help desk saved views",
    description:
      "Named filters in the help desk's menu. Each has conditions a conversation must meet: status (active, open, pending, snoozed, closed, any), assignee (me, none or a user id), any of some tags, a folder id or none, priorities, words in the subject or customer, and unread only.",
    schema: deskViewsSchema,
    defaultBody: () => DEFAULT_DESK_VIEWS,
  },
  {
    module: HELPDESK_MODULE,
    key: DESK_SETTINGS_KEY,
    feature: "helpdesk",
    name: "Help desk behaviour",
    description:
      "How the help desk behaves: the business's own support addresses (never copied in by Reply all), how many seconds a sent email waits so it can be undone (0, 5, 10 or 20), what happens after closing a conversation (next, list or stay), and whether the first conversation opens by itself.",
    schema: deskSettingsSchema,
    defaultBody: () => DEFAULT_DESK_SETTINGS,
  },
  {
    module: HELPDESK_MODULE,
    key: CHANNELS_KEY,
    feature: "helpdesk",
    name: "Help desk channels",
    description:
      "Which messages besides email come into the help desk: Instagram messages (instagram) and Facebook messages (facebook), each on or off. They only work once Facebook & Instagram is connected with the messaging permissions, which a person does under Settings → Help desk → Channels. human_agent is only for a Meta app approved for the Human Agent feature (replies up to seven days after the customer's last message) and should stay off otherwise. take_control is for a business that also uses another inbox tool on the same account: when Meta refuses a reply because that tool has the conversation, the help desk takes it over and tries once more. It pulls conversations away from the other tool, so it stays off unless the owner asks for exactly that.",
    schema: channelSettingsSchema,
    defaultBody: () => DEFAULT_CHANNEL_SETTINGS,
  },
  {
    module: HELPDESK_MODULE,
    key: AUTO_REPLIES_KEY,
    feature: "helpdesk",
    name: "Help desk automatic replies",
    description:
      "The short message the help desk sends by itself when someone writes in, per channel (instagram, facebook, email): on or off, when (always, outside_hours for only while closed, or both for one message while open and another while closed), the message and the away_message. The two messages are sent to customers by themselves, so only a person may write them, under Settings → Help desk → Automatic replies: a proposal must leave every message and away_message exactly as it is now, and one that changes any of them is refused. You can propose the switches, when, the hours and the quiet period. hours are the weekly opening hours on the workspace's own clocks (weekday 0 is Sunday, start_minute and end_minute past midnight). quiet_hours (1 to 168, usually 24) is how long before the same person can get another automatic reply on that channel. Everything is off by default.",
    schema: autoRepliesSchema,
    defaultBody: () => DEFAULT_AUTO_REPLIES,
    // No model writes what the help desk sends by itself (CLAUDE.md rule 6).
    refuse: (next, current) =>
      autoReplyWordsChanged(next as AutoReplies, current as AutoReplies)
        ? "The words of an automatic reply go to customers by themselves, so only a person can write them: Settings → Help desk → Automatic replies. Propose the change again with every message and away_message exactly as they are now, and tell the person where to write the words."
        : null,
  },
  {
    module: HELPDESK_MODULE,
    key: TAG_GROUPS_KEY,
    feature: "helpdesk",
    name: "Help desk tag groups",
    description:
      "Headings that arrange the help desk's tag picker. Each group has a name and the tags under it; a tag in no group still works.",
    schema: tagGroupsSchema,
    defaultBody: () => DEFAULT_TAG_GROUPS,
  },
  {
    module: HELPDESK_MODULE,
    key: MANUAL_KEY,
    feature: "helpdesk",
    name: "Help desk manual",
    description:
      "The help desk's manual of topics and articles: its name and the first tab's name, a sentence on what belongs in it, the labels topics are sorted by (id and label, up to four), the headings a topic is written under, which conversations feed it (folder ids, saved view ids, tags), whether it updates by itself (auto) and how often (day or week), the most conversations read in a month (monthly_cap), whether Claude is shown customers' photos (read_photos) and whether reply drafts may lean on published topics (use_in_drafts).",
    schema: manualConfigSchema,
    defaultBody: () => DEFAULT_MANUAL,
  },
  {
    module: HELPDESK_MODULE,
    key: HELP_CENTRE_KEY,
    feature: "helpdesk",
    name: "Help centre",
    description:
      "The public help centre customers can read: whether it is on (while off, every page answers not found), its title and the line under it, the categories articles are grouped by in order (id and label, up to twelve), the sentence beside the contact address (contact_line), the address customers write to (contact_email, empty for the workspace's own support address) and whether search engines are asked to leave it out (noindex). Which articles are published is not a setting: an owner or admin publishes each one.",
    schema: helpCentreConfigSchema,
    defaultBody: () => DEFAULT_HELP_CENTRE,
  },
  {
    module: BOOKINGS_MODULE,
    key: FORM_KEY,
    feature: "bookings",
    name: "Booking form questions",
    description:
      "Extra questions customers answer when they book (name and email are always asked).",
    schema: bookingFormSchema,
    defaultBody: () => DEFAULT_FORM,
  },
  {
    module: BOOKINGS_MODULE,
    key: EMAILS_KEY,
    feature: "bookings",
    name: "Booking emails",
    description:
      "How many hours ahead the reminder goes out (reminder_hours), whether a second short reminder goes out on the day (day_of_on, off unless switched on) and how many hours before the start (day_of_hours, 1 to 24, only sent when shorter than reminder_hours), whether a thank-you is sent afterwards, whether the customer is emailed when a refund or cancellation in the shop cancels their booking (shop_cancel_email), and the business's own note added to the confirmation, reminder, day-of reminder and thank-you emails.",
    schema: bookingEmailsSchema,
    defaultBody: () => DEFAULT_EMAILS,
  },
  {
    module: BOOKINGS_MODULE,
    key: WORDS_KEY,
    feature: "bookings",
    name: "Booking email words",
    description:
      "The business's own words for each booking email (messages: confirmation, reminder, day_of, followup, booking_cancelled, session_cancelled, shop_cancelled, moved, date_changed; each a subject and a plain-text body with fill-ins like {{first_name}}; a message left out uses the standard words) and where customers' replies go (reply_to, an email address, empty for none). These emails go to customers by themselves, so only a person may write their words, under Settings → Bookings → Email words: a proposal must leave messages exactly as they are now, and one that changes any is refused. You can propose reply_to.",
    schema: emailWordsSchema,
    defaultBody: () => DEFAULT_EMAIL_WORDS,
    // No model writes what goes to customers by itself (CLAUDE.md rule 6).
    refuse: (next, current) =>
      messageWordsChanged(next as EmailWords, current as EmailWords)
        ? "The words of a booking email go to customers by themselves, so only a person can write them: Settings → Bookings → Email words. Propose the change again with messages exactly as they are now, and tell the person where to write the words."
        : null,
  },
  {
    module: BOOKINGS_MODULE,
    key: DAILY_KEY,
    feature: "bookings",
    name: "Daily bookings email",
    description:
      "A short email once a day to chosen people in the workspace: today's and tomorrow's classes and how full they are, bookings made in the last day, and anything over its limit or waiting for a date. on (off by default), hour (0 to 23 on the workspace's own clock, 7 by default) and recipients (the user ids of workspace members, up to 20; anyone not a member is never sent it).",
    schema: dailyEmailSchema,
    defaultBody: () => DEFAULT_DAILY_EMAIL,
  },
  {
    module: BOOKINGS_MODULE,
    key: TEXTS_KEY,
    feature: "bookings",
    name: "Booking text reminders",
    description:
      "Texts about a booking through the business's own Twilio account, only to people who ticked the box and gave a mobile number: whether texts are on (on, off by default), the country numbers without a country code belong to (default_country: US, CA, GB, IE, AU or NZ), the hours before the date the reminder goes (reminder_hours, 1 to 336, 48 by default), the day-of reminder (day_of_hours, 1 to 24) and the hours after for the thank-you (followup_hours, 1 to 168), and for each message (confirmation, reminder, day_of, followup, cancelled, moved) whether it goes (on). The words of each text, the line beside the tick box (consent_words) and the opt-out line (opt_out_line) go to customers by themselves or are what they agree to, so only a person may write them, under Settings → Bookings → Text reminders: a proposal must leave every body, consent_words and opt_out_line exactly as they are now, and one that changes any is refused.",
    schema: textSettingsSchema,
    defaultBody: () => DEFAULT_TEXT_SETTINGS,
    // No model writes what goes to customers by itself (CLAUDE.md rule 6).
    refuse: (next, current) =>
      textWordsChanged(parseTextSettings(next), parseTextSettings(current))
        ? "The words of a text, the line beside the tick box and the opt-out line can only be written by a person: Settings → Bookings → Text reminders. Propose the change again with them exactly as they are now, and tell the person where to write the words."
        : null,
  },
  {
    module: BOOKINGS_MODULE,
    key: BUDGET_KEY,
    feature: "bookings",
    name: "Classroom budget",
    description:
      "How the Bookings budget prices teaching and materials: the teachers (up to ten, each with a short id of lowercase letters, digits and dashes, a name and an hourly rate in cents, hourly_cents; the first is who teaches a class unless the class says otherwise), the prep and clean-up hours paid on top of each class (overhead_hours, 0 to 24, 2 by default) and the waste allowance on materials priced by the square foot (waste_percent, 0 to 100, 10 by default). Fixed costs, material rates and other income are typed in on the Budget page, not here.",
    schema: budgetSettingsSchema,
    defaultBody: () => DEFAULT_BUDGET,
  },
  {
    module: BOOKINGS_MODULE,
    key: SHOP_TAGS_KEY,
    feature: "bookings",
    name: "Order tags in the shop",
    description:
      "Whether shop orders that need a person are tagged in the business's shop (on, on by default; nothing is tagged unless the shop was connected with permission to change orders), and the tag words, each up to 40 characters with no commas, empty for the standard word: oversold (a paid order booked into a full date, standard ttw-oversold), needs_date (a workshop paid for with no date on the cart line, standard ttw-needs-date) and booking_error (the date on the line can't be found or was cancelled, standard ttw-booking-error). Tags are only ever added, once per order and reason, when the order comes in; a changed word applies to orders from then on.",
    schema: shopTagsSchema,
    defaultBody: () => DEFAULT_SHOP_TAGS,
  },
  {
    module: BOOKINGS_MODULE,
    key: UPCOMING_KEY,
    feature: "bookings",
    name: "Upcoming classes list",
    description:
      "The list of open workshop dates a business can put on its shop's own workshops page: whether it shows at all (on, off by default; while off the list shows its plain message), its heading (title), how many dates at most (max_dates, 1 to 50), whether it says how many places are left (show_seats_left), the button words (button_words) and what it says when nothing is open (empty_message). Only workshops sold through the shop are listed, and only public, open, future dates with a place left. Changes show within a minute or two; the snippet itself never needs pasting again.",
    schema: upcomingSchema,
    defaultBody: () => DEFAULT_UPCOMING,
  },
  {
    module: BOOKINGS_MODULE,
    key: SHOP_PAGE_KEY,
    feature: "bookings",
    name: "Shop product page",
    description:
      "The date picker on the business's own shop product pages, for workshops sold through the shop: the shop tag that marks a workshop product (product_tag), how many hours before the start bookings stop (cutoff_hours), the button colour (accent, a # and six hex digits), where a shopper is sent when the dates can't be shown (contact_url, https only, and contact_email), the business's own words for that message (fallback_message) and, for a theme whose buy button the usual rule misses, a CSS selector for what to hide (hide_selector). The cut-off, contact details and message take effect at once; a changed tag, colour or selector needs the snippets pasted into the shop theme again.",
    schema: shopPageSchema,
    defaultBody: () => DEFAULT_SHOP_PAGE,
  },
  {
    module: STOCK_MODULE,
    key: STOCK_SETTINGS_KEY,
    feature: "stock",
    name: "Stock planning",
    description:
      "The lead time and days of cover used when a supplier doesn't say, how often orders are reviewed, whether busy seasons are planned for, whether checked-in deliveries are added to the shop's count, the words in an item's name (skip_words) and the shop tags (skip_tags) that mean it is never reordered (gift cards and the like), and whether payments to suppliers are read from the connected books onto supplier balances (payments_from_books).",
    schema: stockSettingsSchema,
    defaultBody: () => DEFAULT_STOCK_SETTINGS,
  },
  {
    module: STOCK_MODULE,
    key: STOCK_VIEWS_KEY,
    feature: "stock",
    name: "Saved views of the reorder list",
    description:
      "Named views of Stock's Everything list, shared by the whole workspace: which built-in view (all, onorder, nosales, hidden, atrisk, out, under, healthy, over, nosupplier), a search, the column it is sorted by and which way, the columns on show, and whether the list opens on it (opens_first, at most one). Each view needs a short id of lowercase letters and digits.",
    schema: savedViewsSchema,
    defaultBody: () => DEFAULT_SAVED_VIEWS,
  },
  {
    module: STOCK_MODULE,
    key: STOCK_HIDDEN_NOTICES_KEY,
    feature: "stock",
    name: "Notices hidden on supplier balances",
    description:
      "The notices on Stock's Balances tab that someone has hidden (an old statement, a payment that may not be in a statement yet, a statement that doesn't add up), as a list of keys. Each key names the notice and its facts, so a notice comes back by itself when its facts change. An empty list shows every notice again.",
    schema: hiddenNoticesSchema,
    defaultBody: () => DEFAULT_HIDDEN_NOTICES,
  },
  {
    module: STOCK_MODULE,
    key: STOCK_SEASONS_KEY,
    feature: "stock",
    name: "Selling seasons to plan ahead for",
    description:
      "Busy times the business wants stock on the shelf for: a name, the day to be in stock by (in_stock_by, YYYY-MM-DD), an optional lift in percent that raises that month's suggested orders (lift_pct, 0 to 500), a note, and how its card sits on Stock's To order tab (card: open, folded or hidden). Each season needs a short id of lowercase letters and digits. Order-by dates per supplier are worked out from these; nothing is ordered by itself.",
    schema: seasonsSchema,
    defaultBody: () => DEFAULT_SEASONS,
  },
  {
    module: STOCK_MODULE,
    key: PO_EMAIL_KEY,
    feature: "stock",
    name: "Purchase order email",
    description:
      "The subject and message an order's email to a supplier starts from when it is sent from the business's own Gmail, whether a copy to the sender is ticked to begin with (cc_me), and the name suppliers see it from (from_name; empty uses the workspace's name). The subject and body may use {{po_reference}}, {{supplier_name}}, {{contact_name}}, {{month}} and {{sender_name}}. This only changes the starting words: a person still looks each email over and presses send themselves.",
    schema: poEmailSchema,
    defaultBody: () => DEFAULT_PO_EMAIL,
  },
  {
    module: STOCK_MODULE,
    key: STOCK_EMAIL_SOURCES_KEY,
    feature: "stock",
    name: "Supplier emails read for balances",
    description:
      "Which emails Stock reads to keep supplier balances up to date, once the business's Gmail has given permission to read: whether reading is on (enabled), the hour of the daily read on the workspace's clock (read_hour), and the sources. Each supplier source names a supplier (supplier_id), who the mail is from (from: an address or a domain), an optional Gmail label and subject words, what the mail is (kind: mixed, invoice, statement or payment), where the figures are (reads: both, attachments or message), words in a file's name that mean it is never read (skip_file_words) and whether everything from it is marked to check (always_check). Each bank source names the bank's sender and, per supplier, the words that show a payment notice is for them (payees: supplier_id, words, and optionally quiet_days to be told when payments stop). Only mail matching a source is ever looked at. Each source needs a short id of lowercase letters and digits.",
    schema: emailSourcesSchema,
    defaultBody: () => DEFAULT_EMAIL_SOURCES,
  },
  {
    module: MICHAELS_MODULE,
    key: MICHAELS_SETTINGS_KEY,
    feature: "stock",
    name: "Michaels Marketplace",
    description:
      "Whether the workspace's Michaels seller account is looked at about once an hour (enabled), how many units of every item are held back from Michaels (units_held_back), and which things each look works out: the stock and the prices that would be sent, and what recent Michaels orders would become in the shop (jobs). The only mode is watch: nothing is ever sent to Michaels or to the shop, and there is no setting that changes that.",
    schema: michaelsSettingsSchema,
    defaultBody: () => DEFAULT_MICHAELS_SETTINGS,
  },
  {
    module: SHIPPING_MODULE,
    key: SHIPPING_SETTINGS_KEY,
    feature: "shipping",
    name: "Shipping and packing slips",
    description:
      "The address parcels are sent from (printed on packing slips and used as the return address on postage labels: name, street, town, state, postcode and phone), the country parcels leave from (anything going elsewhere counts as international), the usual carrier, whether recording a parcel also marks the order as sent in the shop and emails the customer, the order total from which a signature is asked for (signature_over), and whether packings are remembered for the same items or for the same products in other quantities (remember_packing).",
    schema: shippingSettingsSchema,
    defaultBody: () => DEFAULT_SHIPPING_SETTINGS,
  },
  {
    module: SHIPPING_MODULE,
    key: SHIPPING_RULES_KEY,
    feature: "shipping",
    name: "Shipping rules",
    description:
      "An ordered list of rules for orders waiting to ship. Each rule has an id, a name, enabled (on or off), conditions that must all match, and actions. A condition has a field (item_quantity, order_total, product_names, product_skus, destination_state, destination_country, shipping_service), an op (eq, gt, lt for the two numbers; includes_any, excludes, contains for the lists) and a value (a number, or names or codes with commas between). An action has a type and a value: set_package (a box's name exactly as in Shipping settings), require_signature (standard or adult), set_service (cheapest, fastest, or a service's name like UPS Ground), place_hold (a note saying why). For each kind of action the first matching rule from the top wins. A choice a person makes on an order always comes before a rule.",
    schema: shippingRulesSchema,
    defaultBody: () => DEFAULT_SHIPPING_RULES,
  },
  {
    module: SHIPPING_MODULE,
    key: SLIP_LAYOUT_KEY,
    feature: "shipping",
    name: "Packing slip layout",
    description:
      "How a packing slip looks, on paper and on a Zebra alike: the top (the workspace's logo and its size, centred or on the left, the store name and when it is written out, the ship-from address), which sections it shows and in what order (ship-to address, shipping method and box, items, order note, thank-you message, order barcode), what each item shows (SKU, product barcode, photo, price), the text size, the thank-you message and the footer line.",
    schema: slipLayoutSchema,
    defaultBody: () => DEFAULT_SLIP_LAYOUT,
  },
  {
    module: SOCIAL_MODULE,
    key: PLAN_KEY,
    feature: "social",
    name: "Social content plan",
    description:
      "The topics the business posts about, the times of the week it likes to post (each with its usual topic), and notes on its voice that drafts follow.",
    schema: socialPlanSchema,
    defaultBody: () => DEFAULT_PLAN,
  },
  {
    module: SOCIAL_MODULE,
    key: LINKS_KEY,
    feature: "social",
    name: "Link page",
    description:
      "The public page of links for a social profile: its heading, a short intro, the links (https only), whether recent posts show, and whether it is published.",
    schema: linkPageSchema,
    defaultBody: () => DEFAULT_LINKS,
  },
  {
    module: SOCIAL_MODULE,
    key: REVIEW_KEY,
    feature: "social",
    name: "Post review",
    description:
      "How posts are reviewed before they go out: require_approval (on: only an approver can schedule a post and everyone else sends it for review; off: anyone who can write can schedule) and approvers (the roles that may approve or send back a post: owner, admin, member; owners always may). Approving is always a person's press; this only says who.",
    schema: reviewSettingsSchema,
    defaultBody: () => DEFAULT_REVIEW,
  },
  {
    module: BRAND_MODULE,
    key: KIT_KEY,
    feature: "social",
    name: "Brand kit",
    description:
      "The brand's name, tagline, what it makes, its named colours (hex, main colour first, one dark and one light), its overall feel, and how it sounds: voice notes, words it likes and words it never uses. Drafts of posts and emails follow it.",
    schema: brandKitSchema,
    defaultBody: () => ({
      version: 1,
      name: "Your brand",
      colors: [
        { name: "ink", hex: "#1f2a2e" },
        { name: "paper", hex: "#f7f3ea" },
      ],
    }),
  },
  {
    module: BRAND_MODULE,
    key: APPEARANCE_KEY,
    feature: "social",
    name: "Appearance",
    description:
      "How the workspace looks to its team: mode is light (dark menu, light page), dark, or device (follows each person's device); brand_colors puts the brand kit's colours on the menu and main buttons.",
    schema: appearanceSchema,
    defaultBody: () => DEFAULT_APPEARANCE,
  },
];

export function findConfig(module: unknown, key: unknown): ConfigEntry | null {
  // Every brand's kit is the same setting under its own key ("kit-<brand id>").
  if (module === BRAND_MODULE && isKitKey(key) && key !== KIT_KEY) {
    const kit = CONFIG_REGISTRY.find(
      (entry) => entry.module === BRAND_MODULE && entry.key === KIT_KEY,
    );
    return kit ? { ...kit, key } : null;
  }
  return CONFIG_REGISTRY.find((entry) => entry.module === module && entry.key === key) ?? null;
}

/** The shape a setting must have, in a form the model can read. */
export function configJsonSchema(entry: ConfigEntry): unknown {
  return z.toJSONSchema(entry.schema, { io: "input", unrepresentable: "any" });
}

/** Checks a proposed body. Returns the cleaned value or the problems, in words. */
export function validateConfig(
  entry: ConfigEntry,
  body: unknown,
): { ok: true; body: Record<string, unknown> } | { ok: false; problems: string[] } {
  const parsed = entry.schema.safeParse(body);
  if (parsed.success) return { ok: true, body: parsed.data as Record<string, unknown> };
  return {
    ok: false,
    problems: parsed.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join(".") || "(top level)"}: ${issue.message}`),
  };
}

const WIDGET_NAMES: Record<string, string> = {
  key_figures: "Key figures",
  sales_over_time: "Sales over time",
  gross_margin: "Gross margin",
  top_products: "Top products",
  sales_by_channel: "Sales by channel",
  cash_on_hand: "Cash on hand",
  ar_aging: "Money you're owed",
};

/**
 * A setting's value as plain lines a maker can read, for the before/after
 * preview. Falls back to the default when the stored value is missing.
 */
export function describeConfig(entry: ConfigEntry, body: unknown): string[] {
  const parsed = entry.schema.safeParse(body);
  const value = (parsed.success ? parsed.data : entry.defaultBody()) as Record<string, unknown>;
  const list = (name: string) => (Array.isArray(value[name]) ? (value[name] as never[]) : []);

  if (entry.module === DASHBOARD_MODULE) {
    const widgets = list("widgets") as {
      type: string;
      title?: string;
      size?: string;
      limit?: number;
    }[];
    return [
      `Default range: ${String(value.range ?? "").replace(/_/g, " ")}`,
      ...widgets.map(
        (w, i) =>
          `${i + 1}. ${w.title ?? WIDGET_NAMES[w.type] ?? w.type}${w.title ? ` (${WIDGET_NAMES[w.type] ?? w.type})` : ""}, ${w.size === "full" ? "full width" : "half width"}${w.limit ? `, top ${w.limit}` : ""}`,
      ),
    ];
  }
  if (entry.key === TEMPLATES_KEY) {
    const templates = list("templates") as { name: string; body: string }[];
    return templates.length
      ? templates.map(
          (t) =>
            `${t.name}: ${t.body.replace(/\s+/g, " ").slice(0, 90)}${t.body.length > 90 ? "…" : ""}`,
        )
      : ["No saved replies"];
  }
  if (entry.key === RULES_KEY) {
    const rules = list("rules") as {
      contains: string;
      where: string;
      tag?: string;
      priority?: string;
      assign_to?: string;
    }[];
    const place: Record<string, string> = {
      anywhere: "subject or message",
      body: "message",
      subject: "subject",
      from: "sender's address",
    };
    return rules.length
      ? rules.map(
          (r) =>
            `"${r.contains}" in the ${place[r.where] ?? r.where} → ${[
              r.tag ? `tag "${r.tag}"` : "",
              r.priority ? `mark ${r.priority}` : "",
              r.assign_to ? "hand to a teammate" : "",
            ]
              .filter(Boolean)
              .join(", ")}`,
        )
      : ["No rules"];
  }
  if (entry.module === SOCIAL_MODULE && entry.key === PLAN_KEY) {
    const topics = list("topics") as { id: string; name: string }[];
    const slots = list("slots") as { weekday: number; time: string; topic: string | null }[];
    const notes = String(value.style_notes ?? "").replace(/\s+/g, " ");
    return [
      `Topics: ${topics.map((t) => t.name).join(", ") || "none yet"}`,
      ...slots.map(
        (slot) =>
          `${WEEKDAY_NAMES[slot.weekday]} ${slot.time}: ${topics.find((t) => t.id === slot.topic)?.name ?? "anything"}`,
      ),
      `Voice notes: ${notes ? `"${notes.slice(0, 120)}${notes.length > 120 ? "…" : ""}"` : "none"}`,
    ];
  }
  if (entry.module === SOCIAL_MODULE && entry.key === REVIEW_KEY) {
    const review = parseReview(body);
    return [
      review.require_approval
        ? "Posts are approved before they can be scheduled"
        : "Anyone who can write can schedule; review is optional",
      `Who approves: ${approverWords(review)}`,
    ];
  }
  if (entry.module === SOCIAL_MODULE && entry.key === LINKS_KEY) {
    const links = list("links") as { label: string; url: string }[];
    return [
      value.published ? "Published" : "Not published",
      `Heading: ${value.heading || "(the business name)"}`,
      ...links.map((link) => `${link.label} → ${link.url}`),
      value.show_posts ? "Shows recent posts" : "Links only",
    ];
  }
  if (entry.module === SHIPPING_MODULE && entry.key === SLIP_LAYOUT_KEY) {
    const sections = list("sections") as { id: keyof typeof SLIP_SECTION_NAMES; on?: boolean }[];
    const clip = (text: unknown) => {
      const t = String(text ?? "").replace(/\s+/g, " ");
      return t ? `"${t.slice(0, 90)}${t.length > 90 ? "…" : ""}"` : "nothing";
    };
    return [
      `Shows, top to bottom: ${
        sections
          .filter((section) => section.on !== false)
          .map((section) => SLIP_SECTION_NAMES[section.id] ?? section.id)
          .join(", ") || "nothing"
      }`,
      `At the top: ${[
        value.show_logo === false ? "no logo" : `the logo (${value.logo_size ?? "medium"})`,
        value.align === "left" ? "on the left" : "centred",
        value.store_name ? `named ${clip(value.store_name)}` : null,
        value.show_return_address === false ? "no address" : "with the ship-from address",
      ]
        .filter(Boolean)
        .join(", ")}`,
      `Items show: ${
        [
          value.show_sku ? "SKUs" : null,
          value.show_barcode ? "product barcodes" : null,
          value.show_photo ? "photos" : null,
          value.show_price ? "prices" : null,
        ]
          .filter(Boolean)
          .join(", ") || "names only"
      }`,
      `Text size: ${value.text_size}`,
      `Thank-you message: ${clip(value.message)}`,
      `Footer: ${clip(value.footer)}`,
    ];
  }
  if (entry.module === SHIPPING_MODULE) {
    const from = (value.ship_from ?? {}) as Record<string, string>;
    return [
      `Slips and labels are from: ${
        [
          from.name,
          from.address1,
          [from.city, [from.region, from.postal_code].filter(Boolean).join(" ")]
            .filter(Boolean)
            .join(", ") || from.city_line,
        ]
          .filter(Boolean)
          .join(", ") || "no address yet"
      }`,
      `Parcels leave from: ${value.ship_from_country ?? "US"}`,
      `Usual carrier: ${value.default_carrier}`,
      value.mark_sent_in_shop
        ? `Parcels are marked as sent in the shop${value.notify_customer ? ", and the shop emails the customer" : ""}`
        : "Orders are marked as sent in the shop by hand",
    ];
  }
  if (entry.module === STOCK_MODULE && entry.key === STOCK_HIDDEN_NOTICES_KEY) {
    const keys = list("keys") as string[];
    return [
      keys.length
        ? `${keys.length} notice${keys.length === 1 ? "" : "s"} hidden`
        : "No notices hidden",
    ];
  }
  if (entry.module === STOCK_MODULE && entry.key === STOCK_SEASONS_KEY) {
    const seasons = list("seasons") as { name: string; in_stock_by: string; lift_pct?: number }[];
    return seasons.length
      ? seasons.map(
          (season) =>
            `${season.name}: in stock by ${season.in_stock_by}${season.lift_pct ? `, +${season.lift_pct}%` : ""}`,
        )
      : ["No seasons planned"];
  }
  if (entry.module === STOCK_MODULE) {
    return [
      `Lead time when a supplier doesn't say: ${value.default_lead_time_days} days`,
      `Each order should cover: ${value.default_coverage_days} days of sales`,
      `Orders are reviewed every ${value.review_buffer_days} days`,
      value.seasonality ? "Plans ahead for busy seasons" : "Doesn't adjust for seasons",
      value.push_to_shop
        ? "Checked-in deliveries are added to the shop's count"
        : "The shop's count is kept by hand",
      value.payments_from_books
        ? "Payments to suppliers are read from the books"
        : "Payments to suppliers are typed in",
    ];
  }
  if (entry.key === EMAILS_KEY) {
    const clip = (text: unknown) => {
      const t = String(text ?? "").replace(/\s+/g, " ");
      return t ? `"${t.slice(0, 90)}${t.length > 90 ? "…" : ""}"` : "nothing added";
    };
    return [
      `Reminder goes out ${value.reminder_hours} hours before`,
      value.followup_on
        ? `Thank-you goes out ${value.followup_hours} hours after`
        : "No thank-you email afterwards",
      `Added to the confirmation: ${clip(value.confirmation_note)}`,
      `Added to the reminder: ${clip(value.reminder_note)}`,
      `Thank-you message: ${clip(value.followup_message)}`,
    ];
  }
  const questions = list("questions") as { label: string; required: boolean }[];
  return questions.length
    ? questions.map((q) => `${q.label}${q.required ? " (must be answered)" : " (optional)"}`)
    : ["No extra questions"];
}
