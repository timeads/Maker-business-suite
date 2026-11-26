import { describe, expect, it } from "vitest";
import type { EventbriteEvent } from "./client";
import { linkState, pickTicketClass, suggestEvent } from "./events";

const event = (id: string, startUtc: string | null, tickets = ["77"]): EventbriteEvent => ({
  id,
  name: `Event ${id}`,
  startUtc,
  ticketClasses: tickets.map((t) => ({ id: t, name: `Ticket ${t}` })),
});

describe("a date and its Eventbrite event", () => {
  // 6pm in New York on a winter evening and on a summer one: the same
  // moment whatever clock it's written on.
  const winter = "2027-01-15T23:00:00.000Z";
  const summer = "2027-07-15T22:00:00.000Z";

  it("is suggested only when the event starts the very same minute", () => {
    const events = [event("1", "2027-01-15T23:00:00Z"), event("2", "2027-07-15T22:00:30Z")];
    expect(suggestEvent(winter, events)?.id).toBe("1");
    expect(suggestEvent(summer, events)?.id).toBe("2");
    // An hour out (a clock change written the wrong way) is not the same date.
    expect(suggestEvent("2027-07-15T23:00:00.000Z", events)).toBeNull();
    expect(suggestEvent("not a time", events)).toBeNull();
  });

  it("isn't guessed between two events, or offered when already linked", () => {
    const two = [event("1", "2027-01-15T23:00:00Z"), event("3", "2027-01-15T23:00:00Z")];
    expect(suggestEvent(winter, two)).toBeNull();
    expect(suggestEvent(winter, two, new Set(["3"]))?.id).toBe("1");
    expect(suggestEvent(winter, [event("1", null)])).toBeNull();
  });

  it("keeps the ticket type asked for, else the event's first", () => {
    const e = event("1", winter, ["77", "78"]);
    expect(pickTicketClass(e, "78")).toBe("78");
    expect(pickTicketClass(e, "99")).toBe("77");
    expect(pickTicketClass(e, null)).toBe("77");
    expect(pickTicketClass(event("2", winter, []), null)).toBeNull();
  });

  it("reads as a status line with words", () => {
    const base = {
      status: "waiting",
      detail: "",
      ticket_class_id: "77",
      checked_at: null,
      eb_hidden: null,
      eb_total: null,
      eb_sold: null,
    };
    expect(linkState(base)).toMatchObject({ tone: "waiting", label: "Not on Eventbrite yet" });
    expect(
      linkState({ ...base, status: "done", checked_at: winter, eb_total: 8, eb_sold: 2 }),
    ).toMatchObject({ tone: "good", label: "On Eventbrite" });
    expect(
      linkState({ ...base, status: "done", checked_at: winter, eb_total: 2, eb_sold: 2 }).label,
    ).toBe("On Eventbrite · sold out there");
    expect(linkState({ ...base, status: "failed", detail: "Eventbrite said no: x" })).toEqual({
      tone: "bad",
      label: "Eventbrite said no",
      detail: "Eventbrite said no: x",
      retry: true,
    });
    expect(linkState({ ...base, status: "unsure" }).retry).toBe(true);
    expect(linkState({ ...base, ticket_class_id: null }).retry).toBe(false);
  });
});
