import { describe, expect, it } from "vitest";
import {
  cardTitle,
  fingerprint,
  firstOpenStep,
  openByStep,
  requiredItems,
  someNames,
  sortItems,
  type SetupItem,
} from "./items";

const item = (id: string, facts: string, step = "one"): SetupItem => ({
  id,
  title: id,
  why: "because",
  to: "dashboard",
  action: "Go",
  facts,
  step,
});

describe("fingerprint", () => {
  it("is short, plain and stable, and changes with the facts", () => {
    expect(fingerprint("debt:a,b")).toBe(fingerprint("debt:a,b"));
    expect(fingerprint("debt:a,b")).not.toBe(fingerprint("debt:a,b,c"));
    expect(fingerprint("")).toMatch(/^[a-z0-9]{1,32}$/);
    expect(fingerprint("x".repeat(5000))).toMatch(/^[a-z0-9]{1,32}$/);
  });
});

describe("sortItems", () => {
  it("rests an item only while its facts are the ones a person said not now to", () => {
    const items = [item("rates", "a,b"), item("lines", "none")];
    const said = [{ item: "rates", fingerprint: fingerprint("a,b") }];
    expect(sortItems(items, said).open.map((i) => i.id)).toEqual(["lines"]);
    expect(sortItems(items, said).resting.map((i) => i.id)).toEqual(["rates"]);
    // A new debt needs a rate: the item comes back by itself.
    const later = [item("rates", "a,b,c"), item("lines", "none")];
    expect(sortItems(later, said).open.map((i) => i.id)).toEqual(["rates", "lines"]);
  });

  it("ignores a not now for an item that isn't open any more", () => {
    expect(sortItems([], [{ item: "gone", fingerprint: "x" }])).toEqual({ open: [], resting: [] });
  });
});

describe("words and steps", () => {
  it("says how many things are left, kindly", () => {
    expect(cardTitle(1)).toBe("One thing would make these figures truer");
    expect(cardTitle(3)).toBe("Three things would make these figures truer");
    expect(cardTitle(12, "to look at")).toBe("12 things to look at");
  });

  it("lands on the first step with something open, else the last", () => {
    const steps = [{ id: "read" }, { id: "lines" }, { id: "review" }].map((s) => ({
      ...s,
      title: s.id,
    }));
    expect(firstOpenStep(steps, [item("a", "", "lines")])).toBe("lines");
    expect(firstOpenStep(steps, [])).toBe("review");
    expect(openByStep([item("a", "", "lines"), item("b", "", "lines")]).get("lines")).toHaveLength(
      2,
    );
  });

  it("names a few, never a long list", () => {
    expect(someNames(["A"])).toBe("A");
    expect(someNames(["A", "B"])).toBe("A and B");
    expect(someNames(["A", "B", "C"])).toBe("A, B and C");
    expect(someNames(["A", "B", "C", "D", "E"])).toBe("A, B, C and 2 more");
  });
});

describe("requiredItems", () => {
  it("leaves out the optional ones, which never nag on a card", () => {
    const items = [item("a", ""), { ...item("b", ""), optional: true }, item("c", "")];
    expect(requiredItems(items).map((i) => i.id)).toEqual(["a", "c"]);
  });
});
