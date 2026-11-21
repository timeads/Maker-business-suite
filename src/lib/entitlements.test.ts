import { describe, expect, it } from "vitest";
import type { SubscriptionStatus, SubscriptionSummary } from "./billing/types";
import { resolveEntitlements } from "./entitlements";

function sub(overrides: Partial<SubscriptionSummary> = {}): SubscriptionSummary {
  return {
    tenant_id: "t",
    plan: "growth",
    status: "active",
    trial_end: null,
    current_period_end: "2026-12-21T00:00:00.000Z",
    cancel_at_period_end: false,
    ended_at: null,
    purge_after: null,
    selected_modules: [],
    ...overrides,
  };
}

describe("resolveEntitlements", () => {
  it("locks every module and keeps the workspace writable before a plan is picked", () => {
    const e = resolveEntitlements(null);
    expect(e.access).toBe("none");
    expect(e.canWrite).toBe(true);
    expect(e.can("module.dashboard")).toBe(false);
    expect(e.can("mcp")).toBe(false);
    expect(e.limit("seats")).toBe(2);
    expect(e.limit("ai_credits")).toBe(0);
  });

  it("gives Starter the money view plus only the one module it chose", () => {
    const none = resolveEntitlements(sub({ plan: "starter" }));
    expect(none.can("module.dashboard")).toBe(true);
    expect(none.can("module.helpdesk")).toBe(false);

    const chosen = resolveEntitlements(
      sub({ plan: "starter", selected_modules: ["bookings", "social"] }),
    );
    expect(chosen.can("module.bookings")).toBe(true);
    // Starter includes one choice; a second stored value is not honoured.
    expect(chosen.can("module.social")).toBe(false);
    expect(chosen.limit("seats")).toBe(2);
  });

  it("gives Growth every module but not MCP, and Studio both", () => {
    const growth = resolveEntitlements(sub({ plan: "growth" }));
    for (const m of ["dashboard", "helpdesk", "bookings", "social"] as const) {
      expect(growth.can(`module.${m}`)).toBe(true);
    }
    expect(growth.can("mcp")).toBe(false);
    expect(growth.limit("seats")).toBe(5);

    const studio = resolveEntitlements(sub({ plan: "studio" }));
    expect(studio.can("mcp")).toBe(true);
    expect(studio.limit("seats")).toBe(10);
    expect(studio.limit("ai_credits")).toBeGreaterThan(growth.limit("ai_credits"));
  });

  it("keeps access during a trial and while a payment is being fixed", () => {
    const trial = resolveEntitlements(
      sub({ status: "trialing", trial_end: "2026-12-05T00:00:00Z" }),
    );
    expect(trial.access).toBe("trialing");
    expect(trial.trialEndsAt).toBe("2026-12-05T00:00:00Z");
    expect(trial.can("module.helpdesk")).toBe(true);

    for (const status of ["past_due", "unpaid"] as SubscriptionStatus[]) {
      const e = resolveEntitlements(sub({ status }));
      expect(e.access).toBe("past_due");
      expect(e.can("module.helpdesk")).toBe(true);
      expect(e.canWrite).toBe(true);
    }
  });

  it("makes the workspace read-only with no features once the subscription ends", () => {
    for (const status of ["canceled", "incomplete_expired", "paused"] as SubscriptionStatus[]) {
      const e = resolveEntitlements(sub({ status, purge_after: "2027-01-20T00:00:00Z" }));
      expect(e.access).toBe("read_only");
      expect(e.canWrite).toBe(false);
      expect(e.can("module.dashboard")).toBe(false);
      expect(e.purgeAfter).toBe("2027-01-20T00:00:00Z");
      expect(e.limit("seats")).toBe(2);
    }
  });

  it("treats an unfinished checkout as no plan", () => {
    const e = resolveEntitlements(sub({ status: "incomplete" }));
    expect(e.access).toBe("none");
    expect(e.can("module.dashboard")).toBe(false);
    expect(e.canWrite).toBe(true);
  });
});
