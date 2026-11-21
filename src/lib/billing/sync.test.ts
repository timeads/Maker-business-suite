import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { processStripeEvent, subscriptionToRow, type SyncableRow, type SyncDeps } from "./sync";

const TENANT = "11111111-1111-4111-8111-111111111111";
const DAY = 86_400;

function stripeSub(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "trialing",
    metadata: { tenant_id: TENANT },
    trial_end: 1_800_000_000,
    cancel_at_period_end: false,
    ended_at: null,
    items: {
      data: [{ current_period_end: 1_800_000_000, price: { lookup_key: "growth_monthly" } }],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

/** A stand-in for Stripe plus our subscriptions table. */
function world(subs: Record<string, Stripe.Subscription>) {
  const table = new Map<string, SyncableRow>();
  let writes = 0;
  const deps: SyncDeps = {
    async retrieveSubscription(id) {
      const found = subs[id];
      if (!found) throw new Error(`No such subscription: ${id}`);
      return found;
    },
    async currentSubscriptionId(tenantId) {
      const row = table.get(tenantId);
      if (!row) return null;
      return { id: row.stripe_subscription_id, ended: row.status === "canceled" };
    },
    async upsertSubscription(row) {
      writes += 1;
      table.set(row.tenant_id, row);
    },
  };
  return { deps, table, subs, writes: () => writes };
}

const event = (id: string, type: string, object: Record<string, unknown>) => ({
  id,
  type,
  payload: { data: { object } },
});

describe("subscriptionToRow", () => {
  it("maps a trialing subscription", () => {
    expect(subscriptionToRow(stripeSub())).toEqual({
      tenant_id: TENANT,
      stripe_customer_id: "cus_1",
      stripe_subscription_id: "sub_1",
      plan: "growth",
      status: "trialing",
      trial_end: new Date(1_800_000_000_000).toISOString(),
      current_period_end: new Date(1_800_000_000_000).toISOString(),
      cancel_at_period_end: false,
      ended_at: null,
      purge_after: null,
    });
  });

  it("starts the 30-day retention clock when a subscription ends", () => {
    const endedAt = 1_800_000_000;
    const row = subscriptionToRow(stripeSub({ status: "canceled", ended_at: endedAt }));
    expect(row.ended_at).toBe(new Date(endedAt * 1000).toISOString());
    expect(row.purge_after).toBe(new Date((endedAt + 30 * DAY) * 1000).toISOString());
  });

  it("refuses subscriptions it can't place", () => {
    expect(() => subscriptionToRow(stripeSub({ metadata: {} }))).toThrow(/tenant_id/);
    expect(() =>
      subscriptionToRow(
        stripeSub({ items: { data: [{ current_period_end: 1, price: { lookup_key: "other" } }] } }),
      ),
    ).toThrow(/price/);
  });
});

describe("processStripeEvent", () => {
  it("walks trial → paid → upgrade → cancel", async () => {
    const w = world({ sub_1: stripeSub() });

    await processStripeEvent(
      event("evt_1", "checkout.session.completed", { id: "cs_1", subscription: "sub_1" }),
      w.deps,
    );
    expect(w.table.get(TENANT)).toMatchObject({ plan: "growth", status: "trialing" });

    w.subs.sub_1 = stripeSub({ status: "active", trial_end: null });
    await processStripeEvent(
      event("evt_2", "customer.subscription.updated", { id: "sub_1" }),
      w.deps,
    );
    expect(w.table.get(TENANT)).toMatchObject({ status: "active", trial_end: null });

    w.subs.sub_1 = stripeSub({
      status: "active",
      items: {
        data: [{ current_period_end: 1_800_000_000, price: { lookup_key: "studio_monthly" } }],
      },
    });
    await processStripeEvent(
      event("evt_3", "customer.subscription.updated", { id: "sub_1" }),
      w.deps,
    );
    expect(w.table.get(TENANT)).toMatchObject({ plan: "studio", status: "active" });

    w.subs.sub_1 = stripeSub({ status: "canceled", ended_at: 1_800_000_000 });
    await processStripeEvent(
      event("evt_4", "customer.subscription.deleted", { id: "sub_1" }),
      w.deps,
    );
    expect(w.table.get(TENANT)).toMatchObject({ status: "canceled" });
    expect(w.table.get(TENANT)?.purge_after).not.toBeNull();
  });

  it("replaying an event, or delivering an old one late, changes nothing", async () => {
    const w = world({ sub_1: stripeSub({ status: "active", trial_end: null }) });
    const created = event("evt_1", "customer.subscription.created", {
      id: "sub_1",
      status: "trialing",
    });
    const updated = event("evt_2", "customer.subscription.updated", {
      id: "sub_1",
      status: "active",
    });

    await processStripeEvent(updated, w.deps);
    const after = structuredClone(w.table.get(TENANT));

    // Stripe redelivers the update, then finally delivers the older "created".
    await processStripeEvent(updated, w.deps);
    await processStripeEvent(created, w.deps);
    expect(w.table.get(TENANT)).toEqual(after);
    expect(w.table.get(TENANT)?.status).toBe("active");
  });

  it("a late cancellation of an old subscription does not clobber a new one", async () => {
    const w = world({
      sub_old: stripeSub({ id: "sub_old", status: "canceled", ended_at: 1_700_000_000 }),
      sub_new: stripeSub({ id: "sub_new", status: "active", trial_end: null }),
    });
    await processStripeEvent(
      event("evt_1", "customer.subscription.created", { id: "sub_new" }),
      w.deps,
    );
    const result = await processStripeEvent(
      event("evt_2", "customer.subscription.deleted", { id: "sub_old" }),
      w.deps,
    );
    expect(result).toBe("ignored");
    expect(w.table.get(TENANT)).toMatchObject({
      stripe_subscription_id: "sub_new",
      status: "active",
    });
  });

  it("lets a workspace resubscribe after cancelling", async () => {
    const w = world({
      sub_old: stripeSub({ id: "sub_old", status: "canceled", ended_at: 1_700_000_000 }),
      sub_new: stripeSub({ id: "sub_new", status: "active", trial_end: null }),
    });
    await processStripeEvent(
      event("evt_1", "customer.subscription.deleted", { id: "sub_old" }),
      w.deps,
    );
    expect(w.table.get(TENANT)?.status).toBe("canceled");
    await processStripeEvent(
      event("evt_2", "checkout.session.completed", { subscription: "sub_new" }),
      w.deps,
    );
    expect(w.table.get(TENANT)).toMatchObject({
      stripe_subscription_id: "sub_new",
      status: "active",
      purge_after: null,
    });
  });

  it("ignores events that aren't about a subscription", async () => {
    const w = world({});
    expect(await processStripeEvent(event("evt_1", "invoice.paid", { id: "in_1" }), w.deps)).toBe(
      "ignored",
    );
    expect(
      await processStripeEvent(
        event("evt_2", "checkout.session.completed", { subscription: null }),
        w.deps,
      ),
    ).toBe("ignored");
    expect(w.writes()).toBe(0);
  });

  it("fails loudly, so the event is retried, when Stripe can't be reached", async () => {
    const w = world({});
    await expect(
      processStripeEvent(
        event("evt_1", "customer.subscription.updated", { id: "sub_missing" }),
        w.deps,
      ),
    ).rejects.toThrow(/No such subscription/);
  });
});
