import { describe, expect, it } from "vitest";
import { homeCards } from "./home";
import {
  MEMBER_TOOLS,
  cleanTools,
  hasNoTools,
  isMemberTool,
  seesCosts,
  toolAllowed,
  type PersonTools,
} from "./tools";
import { resolveEntitlements } from "../entitlements";
import type { SubscriptionSummary } from "../billing/types";

const growth: SubscriptionSummary = {
  tenant_id: "t",
  plan: "growth",
  status: "active",
  trial_end: null,
  current_period_end: "2026-12-21T00:00:00.000Z",
  cancel_at_period_end: false,
  ended_at: null,
  purge_after: null,
  selected_modules: [],
};
const starter: SubscriptionSummary = { ...growth, plan: "starter", selected_modules: ["stock"] };
const person = (over: Partial<PersonTools> = {}): PersonTools => ({
  role: "member",
  on: true,
  tools: [],
  ...over,
});

describe("toolAllowed", () => {
  it("gives owners and admins every tool, Money included, switch or no switch", () => {
    for (const role of ["owner", "admin"] as const) {
      for (const on of [true, false]) {
        for (const tool of ["dashboard", "messages", ...MEMBER_TOOLS] as const) {
          expect(toolAllowed(person({ role, on, tools: null }), tool)).toBe(true);
        }
      }
    }
  });

  it("gives a member everything while the switch is off", () => {
    expect(toolAllowed(person({ on: false, tools: null }), "dashboard")).toBe(true);
    expect(toolAllowed(person({ on: false, tools: [] }), "stock")).toBe(true);
  });

  it("gives a member only the ticked tools once it is on, and never Money", () => {
    const p = person({ tools: ["stock", "dashboard"] });
    expect(toolAllowed(p, "stock")).toBe(true);
    expect(toolAllowed(p, "shipping")).toBe(false);
    expect(toolAllowed(p, "dashboard")).toBe(false);
    expect(toolAllowed(person({ tools: null }), "stock")).toBe(false);
  });

  it("keeps Messages open to everyone on the team", () => {
    expect(toolAllowed(person({ tools: [] }), "messages")).toBe(true);
    expect(toolAllowed(null, "messages")).toBe(false);
  });
});

describe("the small helpers", () => {
  it("sees costs only where Money's rule allows", () => {
    expect(seesCosts(person())).toBe(false);
    expect(seesCosts(person({ on: false }))).toBe(true);
    expect(seesCosts(person({ role: "admin" }))).toBe(true);
    expect(seesCosts(null)).toBe(false);
  });

  it("cleans a ticked list and never keeps Money", () => {
    expect(cleanTools(["shipping", "dashboard", "x", "helpdesk", "shipping"])).toEqual([
      "helpdesk",
      "shipping",
    ]);
    expect(isMemberTool("dashboard")).toBe(false);
    expect(isMemberTool("stock")).toBe(true);
  });

  it("knows a member with nothing to open yet", () => {
    expect(hasNoTools(person())).toBe(true);
    expect(hasNoTools(person({ tools: ["social"] }))).toBe(false);
    expect(hasNoTools(person({ on: false }))).toBe(false);
    expect(hasNoTools(person({ role: "admin" }))).toBe(false);
  });
});

describe("entitlements for a person", () => {
  it("are the plan's alone without a person, as before", () => {
    const e = resolveEntitlements(growth);
    expect(e.can("module.dashboard")).toBe(true);
    expect(e.seesCosts).toBe(true);
    expect(e.toolsPerPerson).toBe(false);
  });

  it("refuse a member's tools that aren't theirs but keep the plan's answer apart", () => {
    const e = resolveEntitlements(growth, null, new Date(), person({ tools: ["stock"] }));
    expect(e.can("module.stock")).toBe(true);
    expect(e.can("michaels")).toBe(true);
    expect(e.can("module.shipping")).toBe(false);
    expect(e.can("texts")).toBe(false);
    expect(e.can("eventbrite")).toBe(false);
    expect(e.can("module.dashboard")).toBe(false);
    expect(e.can("module.messages")).toBe(true);
    expect(e.onPlan("module.shipping")).toBe(true);
    expect(e.onPlan("module.dashboard")).toBe(true);
    expect(e.seesCosts).toBe(false);
    expect(e.toolsPerPerson).toBe(true);
  });

  it("never give a member a tool the plan doesn't have", () => {
    const e = resolveEntitlements(
      starter,
      null,
      new Date(),
      person({ tools: ["stock", "social"] }),
    );
    expect(e.can("module.stock")).toBe(true);
    expect(e.can("module.social")).toBe(false);
    expect(e.onPlan("module.social")).toBe(false);
  });

  it("change nothing for owners and admins", () => {
    for (const role of ["owner", "admin"] as const) {
      const e = resolveEntitlements(growth, null, new Date(), person({ role, tools: null }));
      expect(e.can("module.dashboard")).toBe(true);
      expect(e.can("module.shipping")).toBe(true);
      expect(e.seesCosts).toBe(true);
    }
  });
});

describe("homeCards", () => {
  it("shows a card only for the tools a person can open", () => {
    const e = resolveEntitlements(growth, null, new Date(), person({ tools: ["shipping"] }));
    expect(homeCards(e, "member")).toEqual({ tools: ["shipping", "messages"], noTools: false });
  });

  it("tells a member with no tools that an owner or admin gives them", () => {
    const e = resolveEntitlements(growth, null, new Date(), person({ tools: [] }));
    expect(homeCards(e, "member")).toEqual({ tools: ["messages"], noTools: true });
  });

  it("shows owners every card, Money's included", () => {
    const e = resolveEntitlements(growth, null, new Date(), person({ role: "owner", tools: null }));
    expect(homeCards(e, "owner").tools).toEqual([
      "helpdesk",
      "shipping",
      "bookings",
      "social",
      "stock",
      "messages",
      "dashboard",
    ]);
    expect(homeCards(e, "owner").noTools).toBe(false);
  });

  it("changes nothing while the switch is off", () => {
    const e = resolveEntitlements(growth, null, new Date(), person({ on: false, tools: null }));
    expect(homeCards(e, "member").tools).toContain("dashboard");
  });
});
