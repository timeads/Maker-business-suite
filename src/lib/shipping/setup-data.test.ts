import { describe, expect, it } from "vitest";
import { loadShippingSetupFacts } from "./setup-data";

/** A member's session that answers each table with the rows given (or none). */
function fake(rows: Record<string, unknown[]> = {}) {
  const chain = (table: string): unknown => {
    const result = { data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length };
    const self: Record<string, unknown> = {
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return new Proxy(self, {
      get: (target, key: string) => (key in target ? target[key] : () => chain(table)),
    });
  };
  return { from: (table: string) => chain(table) } as never;
}

describe("loadShippingSetupFacts: the slip's logo", () => {
  it("counts a picture tagged “Logo” the way the slip finds it", async () => {
    const facts = await loadShippingSetupFacts(
      fake({ social_assets: [{ id: "a", tags: ["Logo"], mime_type: "image/png" }] }),
      { id: "t1" },
    );
    expect(facts.slip.logo).toBe(true);
  });

  it("doesn't count a picture without the tag", async () => {
    const facts = await loadShippingSetupFacts(
      fake({ social_assets: [{ id: "a", tags: ["boxes"], mime_type: "image/png" }] }),
      { id: "t1" },
    );
    expect(facts.slip.logo).toBe(false);
  });
});
