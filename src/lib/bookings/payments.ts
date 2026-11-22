import type { BookingDetails } from "./emails";

/** What we need to know about a Stripe Checkout session on a business's account. */
export type CheckoutInfo = {
  id: string;
  payment_status: string;
  payment_intent: string | null;
  metadata: Record<string, string>;
};

export type PaymentDeps = {
  /** Reads the Checkout session from Stripe, on the connected account. */
  retrieveCheckout(checkoutId: string, account: string): Promise<CheckoutInfo>;
  /** The Stripe account a workspace takes booking payments into, if connected. */
  payoutAccountFor(tenantId: string): Promise<string | null>;
  /** The Checkout session we created for a booking. */
  checkoutIdFor(tenantId: string, bookingId: string): Promise<string | null>;
  /** Marks the booking paid; true only the first time. */
  confirm(tenantId: string, bookingId: string, paymentIntent: string | null): Promise<boolean>;
  release(tenantId: string, bookingId: string): Promise<void>;
  details(tenantId: string, bookingId: string): Promise<BookingDetails | null>;
  /** Emails the customer and the workspace's owners. */
  announce(details: BookingDetails, manageToken: string): Promise<void>;
};

export type CheckoutOutcome =
  | {
      result: "confirmed" | "already_confirmed";
      tenantId: string;
      bookingId: string;
      manageToken: string;
    }
  | { result: "unpaid" | "not_ours" | "released" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Finds the booking a Checkout session belongs to. Stripe's metadata alone
 * isn't proof: any connected account can create a session with whatever
 * metadata it likes. So the session must sit on the account the workspace
 * connected, and be the very session we created for that booking.
 */
async function ownedBooking(checkout: CheckoutInfo, account: string, deps: PaymentDeps) {
  const tenantId = checkout.metadata.tenant_id ?? "";
  const bookingId = checkout.metadata.booking_id ?? "";
  if (!UUID.test(tenantId) || !UUID.test(bookingId)) return null;
  if ((await deps.payoutAccountFor(tenantId)) !== account) return null;
  if ((await deps.checkoutIdFor(tenantId, bookingId)) !== checkout.id) return null;
  return { tenantId, bookingId };
}

/**
 * Confirms a booking once Stripe says its Checkout session is paid. Safe to
 * call any number of times, from the webhook queue and from the customer's
 * return to our site: the state is re-read from Stripe, and the emails go out
 * only on the call that actually confirms.
 */
export async function confirmCheckout(
  checkoutId: string,
  account: string,
  deps: PaymentDeps,
): Promise<CheckoutOutcome> {
  const checkout = await deps.retrieveCheckout(checkoutId, account);
  const owned = await ownedBooking(checkout, account, deps);
  if (!owned) return { result: "not_ours" };
  if (checkout.payment_status !== "paid") return { result: "unpaid" };

  const first = await deps.confirm(owned.tenantId, owned.bookingId, checkout.payment_intent);
  if (first) {
    const details = await deps.details(owned.tenantId, owned.bookingId);
    if (details) await deps.announce(details, checkout.metadata.manage_token ?? "");
  }
  return {
    result: first ? "confirmed" : "already_confirmed",
    ...owned,
    manageToken: checkout.metadata.manage_token ?? "",
  };
}

/** Frees the seats when a Checkout session ran out without being paid. */
export async function releaseCheckout(
  checkoutId: string,
  account: string,
  deps: PaymentDeps,
): Promise<CheckoutOutcome> {
  const checkout = await deps.retrieveCheckout(checkoutId, account);
  const owned = await ownedBooking(checkout, account, deps);
  if (!owned) return { result: "not_ours" };
  if (checkout.payment_status === "paid") return confirmCheckout(checkoutId, account, deps);
  await deps.release(owned.tenantId, owned.bookingId);
  return { result: "released" };
}

export type ConnectEvent = {
  id: string;
  type: string;
  payload: { account?: string; data?: { object?: { id?: string } } };
};

/** True for events that came from a connected account rather than our own. */
export function isConnectEvent(event: { payload: object }): event is ConnectEvent {
  const account = (event.payload as { account?: unknown }).account;
  return typeof account === "string" && account.length > 0;
}

/** Applies one queued event from a business's Stripe account. */
export async function processConnectEvent(event: ConnectEvent, deps: PaymentDeps): Promise<string> {
  const account = event.payload.account;
  const checkoutId = event.payload.data?.object?.id;
  if (!account || !checkoutId) return "ignored";
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return (await confirmCheckout(checkoutId, account, deps)).result;
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed":
      return (await releaseCheckout(checkoutId, account, deps)).result;
    default:
      return "ignored";
  }
}
