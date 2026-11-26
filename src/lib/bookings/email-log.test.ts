import { describe, expect, it } from "vitest";
import { logHref, logState, parseLogFilters, statusesFor } from "./email-log";

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
      q: "pat",
    });
    expect(parseLogFilters({ kind: "spam", state: ["x"], q: undefined })).toEqual({
      kind: null,
      state: null,
      q: "",
    });
  });

  it("asks the table for the right rows", () => {
    expect(statusesFor("waiting")).toEqual(["queued", "sending"]);
    expect(statusesFor("trying")).toEqual(["failed"]);
    expect(statusesFor("unsure")).toEqual(["unsure"]);
  });

  it("changes one filter and keeps the rest", () => {
    const filters = { kind: "reminder" as const, state: null, q: "pat" };
    expect(logHref("/w/a/bookings/emails", filters, { state: "sent" })).toBe(
      "/w/a/bookings/emails?kind=reminder&state=sent&q=pat",
    );
    expect(logHref("/w/a/bookings/emails", { kind: null, state: null, q: "" }, {})).toBe(
      "/w/a/bookings/emails",
    );
  });
});
