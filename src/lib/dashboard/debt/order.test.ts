import { describe, expect, it } from "vitest";
import { moveTo, noPlaceWords, ownOrder, takesPlace, withPlaces } from "./order";

const debt = (
  id: string,
  priority: number | null,
  more: Partial<{
    plan: "pool" | "fixed" | "revenue_share";
    status: "active" | "paused" | "closed";
    consolidated: boolean;
  }> = {},
) => ({
  id,
  name: id,
  priority,
  plan: more.plan ?? ("pool" as const),
  status: more.status ?? ("active" as const),
  consolidated: more.consolidated ?? false,
});

describe("your own order", () => {
  it("only the pool's active debts take a place", () => {
    expect(takesPlace(debt("a", 1))).toBe(true);
    expect(takesPlace(debt("b", 1, { plan: "fixed" }))).toBe(false);
    expect(takesPlace(debt("c", 1, { plan: "revenue_share" }))).toBe(false);
    expect(takesPlace(debt("d", 1, { status: "paused" }))).toBe(false);
    expect(takesPlace(debt("e", 1, { status: "closed" }))).toBe(false);
    expect(takesPlace(debt("f", 1, { consolidated: true, plan: "fixed" }))).toBe(false);
  });

  it("orders by place, no place last, then by name", () => {
    const list = [
      debt("c", null),
      debt("b", 2),
      debt("a", 2),
      debt("z", 1),
      debt("x", 1, { plan: "fixed" }),
    ];
    expect(ownOrder(list).map((d) => d.id)).toEqual(["z", "a", "b", "c"]);
  });

  it("moves as an insert, clamped at both ends", () => {
    const ids = ["a", "b", "c", "d", "e"];
    expect(moveTo(ids, 3, 2)).toEqual(["a", "d", "b", "c", "e"]);
    expect(moveTo(ids, 1, 4)).toEqual(["a", "c", "d", "b", "e"]);
    expect(moveTo(ids, 4, 1)).toEqual(["e", "a", "b", "c", "d"]);
    expect(moveTo(ids, 0, 5)).toEqual(["b", "c", "d", "e", "a"]);
    expect(moveTo(ids, 2, 99)).toEqual(["a", "b", "d", "e", "c"]);
    expect(moveTo(ids, 2, -4)).toEqual(["c", "a", "b", "d", "e"]);
    expect(moveTo(ids, 9, 1)).toEqual(ids);
  });

  it("lists placed debts first, numbered 1..N, then the rest", () => {
    const list = [
      debt("loan", 1, { plan: "fixed" }),
      debt("b", 7),
      debt("a", 3),
      debt("p", 2, { status: "paused" }),
    ];
    expect(withPlaces(list).map((r) => [r.debt.id, r.place])).toEqual([
      ["a", 1],
      ["b", 2],
      ["loan", null],
      ["p", null],
    ]);
    expect(noPlaceWords(debt("p", 2, { status: "paused" }))).toBe("Paused");
    expect(noPlaceWords(debt("a", 1))).toBeNull();
  });
});
