import { describe, expect, it } from "vitest";
import type { SubscriptionStatus, SubscriptionSummary } from "./billing/types";
import { resolveEntitlements, type PlanGrant } from "./entitlements";

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

  it("opens the Michaels connector wherever Stock is open, and nowhere else", () => {
    expect(resolveEntitlements(null).can("michaels")).toBe(false);
    expect(resolveEntitlements(sub({ plan: "starter" })).can("michaels")).toBe(false);
    expect(
      resolveEntitlements(sub({ plan: "starter", selected_modules: ["bookings"] })).can("michaels"),
    ).toBe(false);
    expect(
      resolveEntitlements(sub({ plan: "starter", selected_modules: ["stock"] })).can("michaels"),
    ).toBe(true);
    expect(resolveEntitlements(sub({ plan: "growth" })).can("michaels")).toBe(true);
    expect(resolveEntitlements(sub({ plan: "studio" })).can("michaels")).toBe(true);
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

  describe("with an internal plan grant", () => {
    const now = new Date("2026-12-10T12:00:00Z");
    const grant = (overrides: Partial<PlanGrant> = {}): PlanGrant => ({
      plan: "studio",
      ends_at: null,
      selected_modules: [],
      ...overrides,
    });

    it("leaves Stripe's answer alone when there is no grant", () => {
      const e = resolveEntitlements(sub({ plan: "starter" }), null, now);
      expect(e.internal).toBeNull();
      expect(e.plan?.key).toBe("starter");
      expect(e.renewsAt).toBe("2026-12-21T00:00:00.000Z");
    });

    it("gives a workspace with no subscription the granted plan, writable", () => {
      const e = resolveEntitlements(null, grant(), now);
      expect(e.access).toBe("active");
      expect(e.plan?.key).toBe("studio");
      expect(e.canWrite).toBe(true);
      expect(e.can("module.shipping")).toBe(true);
      expect(e.can("mcp")).toBe(true);
      expect(e.limit("seats")).toBe(10);
      expect(e.internal).toEqual({ endsAt: null });
      expect(e.renewsAt).toBeNull();
      expect(e.trialEndsAt).toBeNull();
    });

    it("carries the end date while the grant is running", () => {
      const e = resolveEntitlements(null, grant({ ends_at: "2027-01-01T00:00:00Z" }), now);
      expect(e.access).toBe("active");
      expect(e.internal).toEqual({ endsAt: "2027-01-01T00:00:00Z" });
    });

    it("wins over a past-due subscription, and over an ended one", () => {
      const pastDue = resolveEntitlements(
        sub({ plan: "starter", status: "past_due" }),
        grant(),
        now,
      );
      expect(pastDue.access).toBe("active");
      expect(pastDue.plan?.key).toBe("studio");
      expect(pastDue.cancelsAtPeriodEnd).toBe(false);

      const ended = resolveEntitlements(
        sub({ status: "canceled", purge_after: "2027-01-20T00:00:00Z" }),
        grant({ plan: "growth" }),
        now,
      );
      expect(ended.access).toBe("active");
      expect(ended.canWrite).toBe(true);
      expect(ended.purgeAfter).toBeNull();
      expect(ended.can("module.helpdesk")).toBe(true);
    });

    it("falls back to whatever Stripe says once the grant has ended", () => {
      const over = grant({ ends_at: "2026-12-10T11:59:59Z" });
      const none = resolveEntitlements(null, over, now);
      expect(none.access).toBe("none");
      expect(none.internal).toBeNull();
      expect(none.can("module.dashboard")).toBe(false);

      const pastDue = resolveEntitlements(sub({ plan: "starter", status: "past_due" }), over, now);
      expect(pastDue.access).toBe("past_due");
      expect(pastDue.plan?.key).toBe("starter");

      const ended = resolveEntitlements(sub({ status: "canceled" }), over, now);
      expect(ended.access).toBe("read_only");
      expect(ended.canWrite).toBe(false);
    });

    it("uses the pick kept on the grant for a plan with a choice of tools", () => {
      const e = resolveEntitlements(
        sub({ plan: "starter", selected_modules: ["social"] }),
        grant({ plan: "starter", selected_modules: ["bookings"] }),
        now,
      );
      expect(e.can("module.bookings")).toBe(true);
      expect(e.can("module.social")).toBe(false);
      expect(e.chosenModules).toEqual(["bookings"]);
    });

    it("ignores a grant for a plan that doesn't exist", () => {
      const e = resolveEntitlements(null, grant({ plan: "platinum" as never }), now);
      expect(e.access).toBe("none");
      expect(e.internal).toBeNull();
    });
  });
});
