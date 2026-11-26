import { describe, expect, it } from "vitest";
import { isStopWord, matchingBookings } from "./opt-out";

describe("replies of STOP", () => {
  it("knows Twilio's opt-out words however they're typed, and only as the whole reply", () => {
    for (const reply of [
      "STOP",
      "stop",
      " Stop. ",
      "STOP ALL",
      "unsubscribe",
      "Cancel",
      "end!",
      "quit",
      "OPT OUT",
      "revoke",
    ]) {
      expect(isStopWord(reply), reply).toBe(true);
    }
    for (const reply of [
      "START",
      "yes",
      "HELP",
      "please stop texting",
      "Can't make it, cancel my booking",
      "",
      null,
    ]) {
      expect(isStopWord(reply), String(reply)).toBe(false);
    }
  });

  it("matches the workspace's bookings by the number as it would be texted", () => {
    const rows = [
      { id: "a", customer_phone: "(215) 555-0134" },
      { id: "b", customer_phone: "+1 215 555 0134" },
      { id: "c", customer_phone: "215-555-0135" },
      { id: "d", customer_phone: "not a number" },
    ];
    expect(matchingBookings(rows, "+12155550134", "US")).toEqual(["a", "b"]);
    expect(matchingBookings(rows, "+12155550134", "GB")).toEqual(["b"]);
  });
});
