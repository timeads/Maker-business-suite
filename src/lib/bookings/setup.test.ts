import { describe, expect, it } from "vitest";
import { requiredItems } from "../setup/items";
import { DEFAULT_EMAILS } from "./config";
import { emailTimingExplained, oversoldExplained, seatsExplained, zoneExplained } from "./explain";
import { serviceFact } from "./setup-data";
import {
  BOOKINGS_STEPS,
  bookingsSetupItems,
  type BookingsSetupFacts,
  type ServiceFact,
} from "./setup";

const NOW = new Date("2026-11-27T15:00:00Z");
const fresh = { status: "active" as const, lastSyncedAt: "2026-11-27T12:00:00Z", lastError: null };
const workshop: ServiceFact = {
  id: "w1",
  name: "Beginners' class",
  kind: "workshop",
  active: true,
  paid: true,
  inShop: false,
};
const appointment: ServiceFact = {
  id: "a1",
  name: "Open studio",
  kind: "appointment",
  active: true,
  paid: false,
  inShop: false,
};

/** A workspace with nothing left to do. */
const done = (more: Partial<BookingsSetupFacts> = {}): BookingsSetupFacts => ({
  now: NOW,
  services: [workshop, appointment],
  workshopsWithDates: ["w1"],
  appointmentsWithHours: ["a1"],
  stripe: { status: "active", chargesEnabled: true },
  shop: fresh,
  shopBookings: 4,
  emails: { timingSaved: true, wordsSaved: true, replyTo: true },
  texts: { connected: true, on: true },
  eventbrite: { connected: true },
  tagPermission: "allowed",
  bookings: 1,
  supplies: 3,
  budget: { saved: true },
  ...more,
});
const ids = (facts: BookingsSetupFacts) => bookingsSetupItems(facts).map((item) => item.id);
const one = (facts: BookingsSetupFacts, id: string) =>
  bookingsSetupItems(facts).find((item) => item.id === id);
const inShop = { ...workshop, id: "w2", name: "Shop class", inShop: true };

describe("bookingsSetupItems", () => {
  it("has nothing to say when everything is in place", () => {
    expect(bookingsSetupItems(done())).toEqual([]);
  });

  it("asks for something to book first", () => {
    expect(ids(done({ services: [] }))).toEqual(["services.none"]);
    // A hidden one doesn't count.
    expect(ids(done({ services: [{ ...workshop, active: false }] }))).toContain("services.none");
  });

  it("asks for dates and open hours, linking straight to a single one", () => {
    expect(one(done({ workshopsWithDates: [] }), "dates.workshops")).toMatchObject({
      to: "bookings/services/w1",
      names: ["Beginners' class"],
      facts: "w1",
    });
    expect(one(done({ appointmentsWithHours: [] }), "dates.hours")?.to).toBe(
      "bookings/services/a1",
    );
    const two = { ...workshop, id: "w9", name: "Another" };
    expect(
      one(done({ services: [workshop, two], workshopsWithDates: [] }), "dates.workshops")?.to,
    ).toBe("bookings/setup#dates");
  });

  it("asks how people pay for priced bookings on our own pages", () => {
    expect(ids(done({ stripe: null }))).toEqual(["selling.stripe"]);
    expect(ids(done({ stripe: { status: "needs_reconnect", chargesEnabled: null } }))).toEqual([
      "selling.stripe-reconnect",
    ]);
    expect(ids(done({ stripe: { status: "active", chargesEnabled: false } }))).toEqual([
      "selling.stripe-not-ready",
    ]);
    // Free, or sold in the shop: no Stripe needed.
    expect(ids(done({ stripe: null, services: [{ ...workshop, paid: false }] }))).toEqual([]);
    expect(ids(done({ stripe: null, services: [inShop], workshopsWithDates: ["w2"] }))).toEqual([]);
  });

  it("asks about the shop only when a workshop is sold there", () => {
    const shopSold = { services: [inShop], workshopsWithDates: ["w2"] };
    expect(ids(done({ ...shopSold, shop: null }))).toEqual(["shop.connect"]);
    expect(ids(done({ shop: null }))).toEqual([]);
  });

  it("asks about the theme's snippet until a booking comes through the shop", () => {
    const shopSold = { services: [inShop], workshopsWithDates: ["w2"] };
    expect(one(done({ ...shopSold, shopBookings: 0 }), "selling.snippet")).toMatchObject({
      to: "settings/bookings/shop-page",
      managersOnly: true,
    });
    expect(
      one(done({ ...shopSold, shopBookings: 0 }), "selling.snippet")?.optional,
    ).toBeUndefined();
    expect(ids(done({ ...shopSold, shopBookings: 2 }))).toEqual([]);
    // Not known: never a false "do this".
    expect(ids(done({ ...shopSold, shopBookings: null }))).toEqual([]);
  });

  it("asks where replies go", () => {
    expect(ids(done({ emails: { timingSaved: true, wordsSaved: true, replyTo: false } }))).toEqual([
      "emails.reply-to",
    ]);
  });

  it("offers the rest as optional, never on the card", () => {
    const facts = done({
      emails: { timingSaved: false, wordsSaved: false, replyTo: true },
      texts: { connected: false, on: false },
      eventbrite: { connected: false },
      services: [workshop, inShop],
      workshopsWithDates: ["w1", "w2"],
      tagPermission: "not_granted",
      bookings: 0,
      supplies: 0,
      budget: { saved: false },
    });
    expect(ids(facts)).toEqual([
      "emails.timing",
      "emails.words",
      "texts",
      "eventbrite",
      "shop.tags",
      "history.import",
      "classroom.supplies",
      "classroom.budget",
    ]);
    expect(requiredItems(bookingsSetupItems(facts))).toEqual([]);
  });

  it("leaves out what the plan or the person's role doesn't have", () => {
    expect(ids(done({ texts: null, eventbrite: null, budget: null, supplies: null }))).toEqual([]);
    expect(ids(done({ texts: { connected: true, on: false } }))).toEqual(["texts"]);
  });

  it("puts every item in a step that exists, for owners and admins to do", () => {
    const steps = new Set(BOOKINGS_STEPS.map((s) => s.id));
    const all = bookingsSetupItems(
      done({
        services: [],
        stripe: null,
        emails: { timingSaved: false, wordsSaved: false, replyTo: false },
        bookings: 0,
      }),
    );
    for (const item of all) {
      expect(steps.has(item.step)).toBe(true);
      expect(item.managersOnly).toBe(true);
      expect(item.facts).not.toMatch(/class/i);
    }
    expect(BOOKINGS_STEPS.at(-1)?.id).toBe("review");
  });

  it("reads a service row as a fact", () => {
    expect(
      serviceFact({
        id: "s",
        kind: "appointment",
        name: "A",
        price_cents: 0,
        active: true,
        shop_product_id: "123",
      }),
    ).toEqual({ id: "s", name: "A", kind: "appointment", active: true, paid: false, inShop: true });
  });
});

describe("Bookings explanations", () => {
  const figures = {
    session_id: "s1",
    taken: 7,
    capacity: 8,
    seat_group_id: null,
    shared_capacity: null,
    shared_taken: null,
    seats_left: 1,
  };

  it("explains places left under the date's own limit", () => {
    const lines = seatsExplained(figures, { capacity: 8 });
    expect(lines.join(" ")).toMatch(/7 places taken/);
    expect(lines.join(" ")).toMatch(/1 is left under it/);
    expect(lines.at(-1)).toBe("Places left: 1.");
  });

  it("explains the shared room as the smaller of the two", () => {
    const lines = seatsExplained(
      { ...figures, seat_group_id: "g", shared_capacity: 12, shared_taken: 12, seats_left: 0 },
      { capacity: 8 },
    );
    expect(lines.join(" ")).toMatch(/12 of 12 taken across them, so 0 left there/);
    expect(lines.join(" ")).toMatch(/smaller of the two: 0/);
  });

  it("says a closed or private date isn't offered online", () => {
    expect(seatsExplained(figures, { capacity: 8, closed: true }).at(-1)).toMatch(/isn't taking/);
    expect(seatsExplained(figures, { capacity: 8, private: true }).at(-1)).toMatch(/private/);
    expect(seatsExplained(undefined, { capacity: 8 })[0]).toMatch(/couldn't be read/);
  });

  it("explains why a booking is over the limit", () => {
    const lines = oversoldExplained({ oversold: 2, taken: 10, capacity: 8 });
    expect(lines[0]).toMatch(/never turned away/);
    expect(lines[1]).toMatch(/2 bookings are marked/);
    expect(oversoldExplained({ oversold: 0, taken: 8, capacity: 8 })).toHaveLength(2);
  });

  it("says when each email goes, from the settings", () => {
    const date = { starts_at: "2027-03-13T14:00:00Z", ends_at: "2027-03-13T16:00:00Z" };
    const usual = emailTimingExplained(DEFAULT_EMAILS, date, "America/New_York", NOW);
    expect(usual[0]).toMatch(/24 hours before it starts: Fri, Mar 12, 9:00 AM EST/);
    expect(usual.join(" ")).toMatch(/thank-you is switched off/);
    const more = emailTimingExplained(
      { ...DEFAULT_EMAILS, day_of_on: true, followup_on: true, followup_hours: 2 },
      date,
      "America/New_York",
      NOW,
    );
    expect(more[1]).toMatch(/2 hours before: Sat, Mar 13, 7:00 AM EST/);
    expect(more[2]).toMatch(/2 hours after it ends: Sat, Mar 13, 1:00 PM EST/);
    const late = emailTimingExplained(
      { ...DEFAULT_EMAILS, day_of_on: true, day_of_hours: 24 },
      date,
      "America/New_York",
      NOW,
    );
    expect(late[1]).toMatch(/doesn't/);
  });

  it("follows the clock change across a reminder", () => {
    // Clocks go forward on Sunday 14 March 2027 in New York.
    const date = { starts_at: "2027-03-14T14:00:00Z", ends_at: "2027-03-14T16:00:00Z" };
    expect(emailTimingExplained(DEFAULT_EMAILS, date, "America/New_York", NOW)[0]).toMatch(
      /Sat, Mar 13, 9:00 AM EST/,
    );
  });

  it("names the zone label shoppers see, in summer and winter", () => {
    expect(zoneExplained("America/New_York", "2027-07-01T12:00:00Z")[1]).toMatch(/“ET”/);
    expect(zoneExplained("America/New_York", "2027-01-01T12:00:00Z")[1]).toMatch(/“ET”/);
    expect(zoneExplained("Europe/London", "2027-07-01T12:00:00Z")[1]).toMatch(/“BST”/);
  });
});
