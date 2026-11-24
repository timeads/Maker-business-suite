import { describe, expect, it } from "vitest";
import { MAX_HIDDEN_NOTICES, balanceNotices, hideNotice } from "./notices";

const facts = {
  supplierId: "s1",
  anchorDate: "2026-08-06T00:00:00.000Z",
  stale: true,
  unreflectedIds: ["p2", "p1"],
  drifted: [{ toDate: "2026-08-06T00:00:00.000Z", delta: "12.50" }],
};

describe("balance notices", () => {
  it("gives each notice a key that carries its facts", () => {
    expect(balanceNotices(facts, []).map((n) => n.key)).toEqual([
      "stale:s1:2026-08-06",
      "unreflected:s1:p1,p2",
      "drift:s1:2026-08-06=12.50",
    ]);
  });

  it("only lists what applies", () => {
    expect(balanceNotices({ ...facts, stale: false, unreflectedIds: [], drifted: [] }, [])).toEqual(
      [],
    );
  });

  it("stays hidden until its facts change, and is separate for each supplier", () => {
    const hidden = hideNotice([], "unreflected:s1:p1,p2");
    const kinds = (list: ReturnType<typeof balanceNotices>) =>
      list.filter((n) => !n.hidden).map((n) => n.kind);
    expect(kinds(balanceNotices(facts, hidden))).toEqual(["stale", "drift"]);
    // Another payment joins: a new key, so it shows again.
    expect(kinds(balanceNotices({ ...facts, unreflectedIds: ["p1", "p2", "p3"] }, hidden))).toEqual(
      ["stale", "unreflected", "drift"],
    );
    expect(kinds(balanceNotices({ ...facts, supplierId: "s2" }, hidden))).toContain("unreflected");
  });

  it("keeps the hidden list short and free of repeats", () => {
    expect(hideNotice(["a", "b"], "a")).toEqual(["b", "a"]);
    const many = Array.from({ length: MAX_HIDDEN_NOTICES + 5 }, (_, i) => `k${i}`);
    const next = hideNotice(many, "new");
    expect(next).toHaveLength(MAX_HIDDEN_NOTICES);
    expect(next.at(-1)).toBe("new");
  });
});
