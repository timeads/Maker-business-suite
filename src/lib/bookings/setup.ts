import type { ShopPermissionState } from "../connections/shop-permission";
import { shopItems, type ConnectionFact } from "../setup/connection";
import type { SetupItem, SetupStep } from "../setup/items";

/**
 * "Finish setting up Bookings": what still stands between the workspace and
 * people booking and paying without a hitch, worked out on read from what it
 * already has (docs/setup-pattern.md). Pure: the facts come from
 * `setup-data.ts`, and nothing here is stored but a person's "Not now".
 *
 * Required items stop people booking, paying or hearing back; optional ones
 * (texts, Eventbrite, order tags, bringing bookings across, the classroom)
 * are offered on the guided page and never on the card. Shop orders waiting
 * for a date are work, not setup, and are never an item here.
 *
 * We can't see a shop's theme, so the date picker's snippet is only ever
 * "done" when a booking has really come in through the shop since a workshop
 * was linked; until then it is an item a person can say "Not now" to.
 */

export const BOOKINGS_TOOL = "bookings";

export const BOOKINGS_STEPS: readonly SetupStep[] = [
  { id: "what", title: "What people can book" },
  { id: "dates", title: "Dates and open hours" },
  { id: "selling", title: "How people pay" },
  { id: "emails", title: "The emails they get" },
  { id: "extras", title: "Extras, if you'd like them" },
  { id: "review", title: "Have a look" },
];

export type ServiceFact = {
  id: string;
  name: string;
  kind: "workshop" | "appointment";
  active: boolean;
  /** Has a price above nothing. */
  paid: boolean;
  /** Sold through the shop (linked to a product): paid there, never on our pages. */
  inShop: boolean;
};

export type BookingsSetupFacts = {
  now: Date;
  services: ServiceFact[];
  /** Active workshops with at least one date still to come. */
  workshopsWithDates: string[];
  /** Active appointments with weekly open hours. */
  appointmentsWithHours: string[];
  /** The business's own Stripe account; null when it was never connected. */
  stripe: { status: ConnectionFact["status"]; chargesEnabled: boolean | null } | null;
  shop: ConnectionFact | null;
  /**
   * Bookings that came in through the shop since a workshop was first linked
   * to its product: the one sign we have that the theme's snippet works.
   * Null when not known.
   */
  shopBookings: number | null;
  emails: {
    /** When reminders and thank-yous go was saved at least once. */
    timingSaved: boolean;
    /** The email words were saved at least once. */
    wordsSaved: boolean;
    /** A reply-to address is set. */
    replyTo: boolean;
  };
  /** Text reminders: null where the plan doesn't include them. */
  texts: { connected: boolean; on: boolean } | null;
  /** Eventbrite: null where the plan doesn't include it. */
  eventbrite: { connected: boolean } | null;
  /** The shop's permission to tag orders, for the order tags. */
  tagPermission: ShopPermissionState;
  /** Bookings of any kind ever made here. Null when not known. */
  bookings: number | null;
  /** Classroom supplies listed. Null when not known. */
  supplies: number | null;
  /** The classroom budget's settings saved. Owners and admins only: null for anyone else. */
  budget: { saved: boolean } | null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ids = (list: readonly { id: string }[]) =>
  list
    .map((s) => s.id)
    .sort()
    .join(",");

/** The open items, in the order the guided setup takes them. */
export function bookingsSetupItems(facts: BookingsSetupFacts): SetupItem[] {
  const items: SetupItem[] = [];
  const live = facts.services.filter((s) => s.active);
  const workshops = live.filter((s) => s.kind === "workshop");
  const appointments = live.filter((s) => s.kind === "appointment");

  if (live.length === 0) {
    items.push({
      id: "services.none",
      title: "Add your first workshop or appointment",
      why: "Your booking page has nothing on it until there's something to book.",
      to: "bookings/setup#what",
      action: "Add one",
      facts: String(facts.services.length),
      step: "what",
      managersOnly: true,
    });
  }

  const withDates = new Set(facts.workshopsWithDates);
  const noDates = workshops.filter((s) => !withDates.has(s.id));
  if (noDates.length > 0) {
    const one = noDates.length === 1 ? noDates[0] : null;
    items.push({
      id: "dates.workshops",
      title: `Add dates to ${plural(noDates.length, "workshop")}`,
      why: "A workshop can only be booked on a date that's still to come.",
      count: noDates.length,
      names: noDates.map((s) => s.name),
      to: one ? `bookings/services/${one.id}` : "bookings/setup#dates",
      action: one ? "Add a date" : "Add dates",
      facts: ids(noDates),
      step: "dates",
      managersOnly: true,
    });
  }
  const withHours = new Set(facts.appointmentsWithHours);
  const noHours = appointments.filter((s) => !withHours.has(s.id));
  if (noHours.length > 0) {
    const one = noHours.length === 1 ? noHours[0] : null;
    items.push({
      id: "dates.hours",
      title: `Set open hours for ${plural(noHours.length, "appointment")}`,
      why: "Appointment times are offered from your weekly open hours. With none, there's no time to pick.",
      count: noHours.length,
      names: noHours.map((s) => s.name),
      to: one ? `bookings/services/${one.id}` : "bookings/setup#dates",
      action: one ? "Set the hours" : "Set their hours",
      facts: ids(noHours),
      step: "dates",
      managersOnly: true,
    });
  }

  // Paid on our own pages: through the business's own Stripe account.
  const paidHere = live.filter((s) => s.paid && !s.inShop);
  if (paidHere.length > 0) {
    const stripe = facts.stripe;
    if (!stripe || stripe.status === "disconnected") {
      items.push({
        id: "selling.stripe",
        title: `Choose how people pay for ${plural(paidHere.length, "booking")} with a price`,
        why: "Paid bookings on your booking page go straight into your own Stripe account. Until it's connected, only free ones can be booked. Selling a workshop in your shop instead works too.",
        count: paidHere.length,
        names: paidHere.map((s) => s.name),
        to: "bookings/setup#selling",
        action: "See the choices",
        facts: ids(paidHere),
        step: "selling",
        managersOnly: true,
      });
    } else if (stripe.status === "needs_reconnect") {
      items.push({
        id: "selling.stripe-reconnect",
        title: "Your Stripe account needs connecting again",
        why: "Until it is, nobody can pay for a booking on your booking page.",
        to: "connections",
        action: "Connect it again",
        facts: "reconnect",
        step: "selling",
        managersOnly: true,
      });
    } else if (stripe.chargesEnabled === false) {
      items.push({
        id: "selling.stripe-not-ready",
        title: "Stripe isn't taking payments for you yet",
        why: "Stripe is usually still checking your details, or needs something more from you. Until then, nothing with a price can be booked.",
        to: "bookings/setup#selling",
        action: "See what to do",
        facts: "charges-off",
        step: "selling",
        managersOnly: true,
      });
    }
  }

  // Sold through the shop: the shop's orders become bookings.
  const inShop = workshops.filter((s) => s.inShop);
  if (inShop.length > 0) {
    items.push(
      ...shopItems(facts.shop, facts.now, {
        what: "Workshops you sell in your shop are booked from its orders.",
        step: "selling",
        readAgain: "connections",
      }),
    );
    if (facts.shop?.status === "active" && facts.shopBookings === 0) {
      items.push({
        id: "selling.snippet",
        title: "Paste the date picker into your shop's theme",
        why: "We can't see your theme from here, so this stays open until the first booking comes in through your shop. Pasted both snippets already? Say “Not now”.",
        to: "settings/bookings/shop-page",
        action: "Get the snippets",
        facts: String(inShop.length),
        step: "selling",
        managersOnly: true,
      });
    }
  }

  if (live.length > 0 && !facts.emails.replyTo) {
    items.push({
      id: "emails.reply-to",
      title: "Say where customers' replies go",
      why: "When someone answers a booking email, it goes to this address. Until you set one, it goes to our sending address instead of to you.",
      to: "settings/bookings/words",
      action: "Add your address",
      facts: "none",
      step: "emails",
      managersOnly: true,
    });
  }

  // Optional from here on: offered on the guided page, never on the card.
  if (live.length > 0 && !facts.emails.timingSaved) {
    items.push({
      id: "emails.timing",
      title: "Check when reminders and thank-yous go",
      why: "Reminders go a day before, and the thank-you is off until you switch it on. That suits most classes.",
      to: "settings/bookings",
      action: "Check the timing",
      facts: "never",
      step: "emails",
      optional: true,
      managersOnly: true,
    });
  }
  if (live.length > 0 && !facts.emails.wordsSaved) {
    items.push({
      id: "emails.words",
      title: "Read through your booking emails",
      why: "They already say everything plainly. Change any of the words so they sound like you.",
      to: "settings/bookings/words",
      action: "Read them",
      facts: "never",
      step: "emails",
      optional: true,
      managersOnly: true,
    });
  }
  if (live.length > 0 && facts.texts && !(facts.texts.connected && facts.texts.on)) {
    items.push({
      id: "texts",
      title: "Send text reminders as well",
      why: "From your own Twilio number, only to people who tick the box when they book. Emails go either way.",
      to: "settings/bookings/texts",
      action: facts.texts.connected ? "Switch them on" : "Set them up",
      facts: facts.texts.connected ? "connected" : "none",
      step: "extras",
      optional: true,
      managersOnly: true,
    });
  }
  if (workshops.length > 0 && facts.eventbrite && !facts.eventbrite.connected) {
    items.push({
      id: "eventbrite",
      title: "Sell some dates on Eventbrite too",
      why: "Eventbrite is only offered the places still free here, so nothing is sold twice.",
      to: "settings/bookings/eventbrite",
      action: "Connect Eventbrite",
      facts: "none",
      step: "extras",
      optional: true,
      managersOnly: true,
    });
  }
  if (
    inShop.length > 0 &&
    (facts.tagPermission === "not_granted" || facts.tagPermission === "asked_not_granted")
  ) {
    items.push({
      id: "shop.tags",
      title: "Tag shop orders that need you",
      why: "An order booked into a full date, or paid with no date, gets a tag in your shop so it's easy to find. It needs your shop's permission to change orders.",
      to: "settings/bookings/shop-tags",
      action: "See the permission",
      facts: facts.tagPermission,
      step: "extras",
      optional: true,
      managersOnly: true,
    });
  }
  if (facts.bookings === 0) {
    items.push({
      id: "history.import",
      title: "Bring your workshops and bookings across",
      why: "Moving from another booking app? Your dates and who's booked come across without anyone being emailed. Starting fresh works just as well.",
      to: "settings/bookings/import",
      action: "Bring them across",
      facts: "none",
      step: "extras",
      optional: true,
      managersOnly: true,
    });
  }
  if (workshops.length > 0 && facts.supplies === 0) {
    items.push({
      id: "classroom.supplies",
      title: "Keep track of classroom supplies",
      why: "Say what each class uses up and you'll know when to order more before a date runs short.",
      to: "bookings/supplies",
      action: "Add a supply",
      facts: "none",
      step: "extras",
      optional: true,
      managersOnly: true,
    });
  }
  if (workshops.length > 0 && facts.budget && !facts.budget.saved) {
    items.push({
      id: "classroom.budget",
      title: "Set up the classroom budget",
      why: "Teaching time and what each class uses, against what it brings in. Only owners and admins see it.",
      to: "settings/bookings/budget",
      action: "Set it up",
      facts: "never",
      step: "extras",
      optional: true,
      managersOnly: true,
    });
  }
  return items;
}
