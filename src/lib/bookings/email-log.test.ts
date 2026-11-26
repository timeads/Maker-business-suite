import { describe, expect, it } from "vitest";
import { channelsFor, logHref, logState, parseLogFilters, statusesFor } from "./email-log";

describe("the message log", () => {
  it("says how each email went in a person's words", () => {
    expect(logState({ status: "sent", next_try_at: null })).toBe("sent");
    expect(logState({ status: "failed", next_try_at: "2027-01-01T00:00:00Z" })).toBe("trying");
    expect(logState({ status: "failed", next_try_at: null })).toBe("failed");
    expect(logState({ status: "unsure", next_try_at: null })).toBe("unsure");
    expect(logState({ status: "queued", next_try_at: null })).toBe("waiting");
    expect(logState({ status: "sending", next_try_at: null })).toBe("waiting");
  });

  it("reads its filters from the address and ignores anything it doesn't know", () => {
    expect(parseLogFilters({ kind: "reminder", state: "failed", q: "  Pat " })).toEqual({
      kind: "reminder",
      state: "failed",
      channel: null,
      q: "pat",
    });
    expect(parseLogFilters({ kind: "spam", state: ["x"], channel: "fax", q: undefined })).toEqual({
      kind: null,
      state: null,
      channel: null,
      q: "",
    });
    expect(parseLogFilters({ channel: "text" }).channel).toBe("text");
  });

  it("asks the table for the right rows", () => {
    expect(statusesFor("waiting")).toEqual(["queued", "sending"]);
    expect(statusesFor("trying")).toEqual(["failed"]);
    expect(statusesFor("unsure")).toEqual(["unsure"]);
  });

  it("changes one filter and keeps the rest", () => {
    const filters = { kind: "reminder" as const, state: null, channel: null, q: "pat" };
    expect(logHref("/w/a/bookings/emails", filters, { state: "sent" })).toBe(
      "/w/a/bookings/emails?kind=reminder&state=sent&q=pat",
    );
    expect(logHref("/w/a/bookings/emails", filters, { channel: "text" })).toBe(
      "/w/a/bookings/emails?channel=text&kind=reminder&q=pat",
    );
    expect(
      logHref("/w/a/bookings/emails", { kind: null, state: null, channel: null, q: "" }, {}),
    ).toBe("/w/a/bookings/emails");
  });

  it("reads only the records a filter needs", () => {
    const none = { kind: null, state: null, channel: null, q: "" };
    expect(channelsFor(none)).toEqual(["email", "text"]);
    expect(channelsFor({ ...none, channel: "email" })).toEqual(["email"]);
    // Only texts carry "You're booked" and "moved" here: those emails go at once.
    expect(channelsFor({ ...none, kind: "confirmation" })).toEqual(["text"]);
    expect(channelsFor({ ...none, kind: "moved", channel: "email" })).toEqual([]);
    expect(channelsFor({ ...none, kind: "reminder" })).toEqual(["email", "text"]);
  });
});
