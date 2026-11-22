import { describe, expect, it } from "vitest";
import { actionsFor, autoTagRulesSchema } from "./config";
import { byUrgency, formatDuration, inView, median, snoozeChoices, VIEWS } from "./views";

const NOW = Date.parse("2026-11-20T15:00:00Z");
const ME = "11111111-1111-4111-8111-111111111111";
const base = { status: "open", assignee_id: null, snoozed_until: null, merged_into: null } as const;

describe("inbox folders", () => {
  it("puts a live conversation in one main folder only", () => {
    const cases = [
      base,
      { ...base, status: "pending" as const },
      { ...base, status: "closed" as const },
      { ...base, snoozed_until: "2026-11-21T15:00:00Z" },
    ];
    for (const ticket of cases) {
      const main = (["open", "pending", "snoozed", "closed"] as const).filter((v) =>
        inView(ticket, v, ME, NOW),
      );
      expect(main).toHaveLength(1);
    }
  });

  it("a snooze that has run out is back in the inbox", () => {
    const ticket = { ...base, snoozed_until: "2026-11-20T14:00:00Z" };
    expect(inView(ticket, "open", ME, NOW)).toBe(true);
    expect(inView(ticket, "snoozed", ME, NOW)).toBe(false);
  });

  it("mine and unassigned follow who has it; folded conversations only show under everything", () => {
    expect(inView({ ...base, assignee_id: ME }, "mine", ME, NOW)).toBe(true);
    expect(inView({ ...base, assignee_id: ME }, "unassigned", ME, NOW)).toBe(false);
    expect(inView(base, "unassigned", ME, NOW)).toBe(true);
    const folded = { ...base, status: "closed" as const, merged_into: "x" };
    expect(VIEWS.filter((v) => inView(folded, v.key, ME, NOW)).map((v) => v.key)).toEqual(["all"]);
  });

  it("sorts urgent to the top, then newest first", () => {
    const rows = [
      { id: "a", priority: "normal" as const, last_message_at: "2026-11-20T10:00:00Z" },
      { id: "b", priority: "urgent" as const, last_message_at: "2026-11-19T10:00:00Z" },
      { id: "c", priority: "low" as const, last_message_at: "2026-11-20T12:00:00Z" },
    ];
    expect(rows.sort(byUrgency).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
});

describe("snooze choices", () => {
  it("mornings are 9:00 on the workspace's clock, across a clock change", () => {
    // Friday 30 October 2026 in New York; clocks go back on Sunday 1 November.
    const choices = snoozeChoices(new Date("2026-10-30T18:00:00Z"), "America/New_York");
    const by = Object.fromEntries(choices.map((c) => [c.key, c.until]));
    expect(by.tomorrow).toBe("2026-10-31T13:00:00.000Z");
    expect(by.monday).toBe("2026-11-02T14:00:00.000Z");
    expect(by["3h"]).toBe("2026-10-30T21:00:00.000Z");
  });

  it("on a Monday, Monday means next week", () => {
    const choices = snoozeChoices(new Date("2026-11-02T18:00:00Z"), "UTC");
    expect(choices.find((c) => c.key === "monday")?.until).toBe("2026-11-09T09:00:00.000Z");
  });
});

describe("rules", () => {
  const rules = autoTagRulesSchema.parse({
    version: 1,
    rules: [
      { id: "a", contains: "refund", where: "anywhere", tag: "refund", priority: "high" },
      { id: "b", contains: "chargeback", where: "anywhere", priority: "urgent" },
      { id: "c", contains: "@bigstore.com", where: "from", tag: "wholesale", assign_to: ME },
      { id: "d", contains: "hello", where: "subject", priority: "low" },
    ],
  });

  it("keeps every tag, the most urgent priority and the first teammate", () => {
    const outcome = actionsFor(rules, {
      subject: "Hello, refund please",
      body: "or I will file a chargeback",
      from: "buyer@bigstore.com",
    });
    expect(outcome.tags.sort()).toEqual(["refund", "wholesale"]);
    expect(outcome.priority).toBe("urgent");
    expect(outcome.assignTo).toBe(ME);
  });

  it("does nothing when no words match", () => {
    expect(actionsFor(rules, { subject: "Lovely rug", body: "Thanks!", from: "a@b.co" })).toEqual({
      tags: [],
      priority: null,
      assignTo: null,
    });
  });

  it("a rule has to do something", () => {
    expect(
      autoTagRulesSchema.safeParse({ version: 1, rules: [{ id: "x", contains: "hi there" }] })
        .success,
    ).toBe(false);
  });
});

describe("report figures", () => {
  it("formats how long things took", () => {
    expect(formatDuration(5 * 60_000)).toBe("5m");
    expect(formatDuration(125 * 60_000)).toBe("2h 5m");
    expect(formatDuration(76 * 3_600_000)).toBe("3d 4h");
  });
  it("finds the middle value", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 9])).toBe(5);
    expect(median([4, 2])).toBe(3);
  });
});
