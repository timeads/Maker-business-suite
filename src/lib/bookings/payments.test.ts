import { describe, expect, it } from "vitest";
import type { BookingDetails } from "./emails";
import {
  confirmCheckout,
  isConnectEvent,
  processConnectEvent,
  type CheckoutInfo,
  type PaymentDeps,
} from "./payments";

const TENANT = "11111111-1111-4111-8111-111111111111";
const BOOKING = "22222222-2222-4222-8222-222222222222";

function setup(overrides: Partial<CheckoutInfo> = {}) {
  const state = { confirmed: 0, released: 0, announced: [] as string[], status: "pending" };
  const checkout: CheckoutInfo = {
    id: "cs_1",
    payment_status: "paid",
    payment_intent: "pi_1",
    metadata: { tenant_id: TENANT, booking_id: BOOKING, manage_token: "tok" },
    ...overrides,
  };
  const deps: PaymentDeps = {
    retrieveCheckout: async () => checkout,
    payoutAccountFor: async (tenantId) => (tenantId === TENANT ? "acct_good" : null),
    checkoutIdFor: async () => "cs_1",
    async confirm() {
      if (state.status === "confirmed") return false;
      state.status = "confirmed";
      state.confirmed += 1;
      return true;
    },
    async release() {
      state.released += 1;
    },
    details: async () => ({ booking_id: BOOKING }) as BookingDetails,
    async announce(_details, token) {
      state.announced.push(token);
    },
  };
  return { state, deps };
}

describe("confirmCheckout", () => {
  it("confirms a paid booking and announces it once, however often it is called", async () => {
    const { state, deps } = setup();
    expect((await confirmCheckout("cs_1", "acct_good", deps)).result).toBe("confirmed");
    expect((await confirmCheckout("cs_1", "acct_good", deps)).result).toBe("already_confirmed");
    expect(state.announced).toEqual(["tok"]);
  });

  it("does nothing until Stripe says the money arrived", async () => {
    const { state, deps } = setup({ payment_status: "unpaid" });
    expect((await confirmCheckout("cs_1", "acct_good", deps)).result).toBe("unpaid");
    expect(state.confirmed).toBe(0);
  });

  it("ignores a session from an account the workspace didn't connect", async () => {
    const { state, deps } = setup();
    expect((await confirmCheckout("cs_1", "acct_evil", deps)).result).toBe("not_ours");
    expect(state.confirmed).toBe(0);
  });

  it("ignores a session that isn't the one we created for the booking", async () => {
    const { state, deps } = setup({ id: "cs_forged" });
    expect((await confirmCheckout("cs_forged", "acct_good", deps)).result).toBe("not_ours");
    expect(state.confirmed).toBe(0);
  });

  it("ignores sessions without our metadata", async () => {
    const { deps } = setup({ metadata: {} });
    expect((await confirmCheckout("cs_1", "acct_good", deps)).result).toBe("not_ours");
  });
});

describe("processConnectEvent", () => {
  const event = (type: string) => ({
    id: "evt_1",
    type,
    payload: { account: "acct_good", data: { object: { id: "cs_1" } } },
  });

  it("releases the seats when checkout expires unpaid", async () => {
    const { state, deps } = setup({ payment_status: "unpaid" });
    expect(await processConnectEvent(event("checkout.session.expired"), deps)).toBe("released");
    expect(state.released).toBe(1);
  });

  it("never releases a booking that turned out to be paid", async () => {
    const { state, deps } = setup();
    expect(await processConnectEvent(event("checkout.session.expired"), deps)).toBe("confirmed");
    expect(state.released).toBe(0);
  });

  it("confirms on completion and ignores everything else", async () => {
    const { deps } = setup();
    expect(await processConnectEvent(event("checkout.session.completed"), deps)).toBe("confirmed");
    expect(await processConnectEvent(event("charge.refunded"), deps)).toBe("ignored");
  });

  it("tells connected-account events from our own", () => {
    expect(isConnectEvent({ payload: { account: "acct_1" } })).toBe(true);
    expect(isConnectEvent({ payload: {} })).toBe(false);
  });
});
