import { describe, expect, it } from "vitest";
import { pickupTells, undoWords } from "./shop-steps";

describe("what a voided parcel says about the shop", () => {
  it("says nothing when the shop was never told", () => {
    expect(undoWords("none")).toBeNull();
    expect(undoWords(undefined)).toBeNull();
  });

  it("says it is on its way, then that it is done", () => {
    expect(undoWords("pending")?.text).toBe("Marking it unfulfilled in your shop…");
    expect(undoWords("sending")?.tone).toBe("waiting");
    expect(undoWords("done")).toEqual({
      tone: "good",
      text: "Marked unfulfilled in your shop",
      detail: null,
    });
  });

  it("asks the person to do it in the shop whenever we couldn't, with why", () => {
    for (const status of ["not_found", "not_allowed", "failed"]) {
      expect(undoWords(status, "Fulfillment is already cancelled")?.text).toBe(
        "Couldn't undo it in your shop: do that there",
      );
    }
    expect(undoWords("failed", "Fulfillment is already cancelled")?.detail).toBe(
      "Your shop said: Fulfillment is already cancelled",
    );
    expect(undoWords("not_allowed")?.detail).toContain("without permission");
  });
});

describe("whether a pickup step reaches the shop", () => {
  it("does only when the workspace wants it and the shop allows it", () => {
    expect(pickupTells({ wanted: true, canSend: true, connected: true })).toBe("yes");
    expect(pickupTells({ wanted: true, canSend: false, connected: true })).toBe("no_permission");
    expect(pickupTells({ wanted: false, canSend: true, connected: true })).toBe("off");
    expect(pickupTells({ wanted: true, canSend: false, connected: false })).toBe("off");
  });
});
