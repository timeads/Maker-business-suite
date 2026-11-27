import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { getStripe } from "../billing/stripe";
import { sendEmail } from "../email";
import { postAlert } from "../messages/alerts";
import { moduleOpen } from "../module-access";
import { queueBookingText, saveTextConsent } from "../texts/queue";
import { textOffer, type TextOffer } from "../texts/read";
import { getAdminClient, withTenant } from "../supabase/admin";
import {
  BOOKINGS_MODULE,
  EMAILS_KEY,
  FORM_KEY,
  parseBookingEmails,
  parseBookingForm,
  type BookingEmails,
  type BookingForm,
} from "./config";
import { manageUrl, ownerNoticeEmail, waitlistEmail, type BookingDetails } from "./emails";
import type { CheckoutInfo, PaymentDeps } from "./payments";
import {
  SHOP_PAGE_KEY,
  parseShopPage,
  shopPageFacts,
  type ShopPage,
  type ShopPageFacts,
} from "./shop-page";
import {
  formatWhen,
  generateSlots,
  isOfferedSlot,
  zoneLabel,
  type AvailabilityRule,
  type Busy,
} from "./slots";
import {
  UPCOMING_KEY,
  parseUpcoming,
  upcomingAnswer,
  type UpcomingAnswer,
  type UpcomingRow,
} from "./upcoming";
import { WORDS_KEY, bookingEmail, parseEmailWords, type EmailWords } from "./words";

/**
 * Server-only. The public booking pages have no database access of their
 * own: everything goes through here with the service role, always naming the
 * workspace (CLAUDE.md rule 2).
 */

export type PublicWorkspace = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
};

export type ServiceRow = {
  id: string;
  kind: "workshop" | "appointment";
  name: string;
  slug: string;
  description: string;
  duration_minutes: number;
  price_cents: number;
  capacity: number;
  active: boolean;
  /** Set when this is sold through the business's own shop, not here. */
  shop_product_id?: string | null;
  /** Where a workshop happens; empty when the business hasn't said. */
  location?: string;
};

export type SessionAvailability = {
  session_id: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  seats_left: number;
};

const SERVICE_COLUMNS =
  "id, kind, name, slug, description, duration_minutes, price_cents, capacity, active, shop_product_id, location";

/** How far ahead appointment times are offered. */
export const BOOKING_WINDOW_DAYS = 28;
/** Stripe keeps a checkout open for at least 30 minutes; the seats are held a little longer. */
const CHECKOUT_MINUTES = 31;
const HOLD_MINUTES = 40;

export const bookingsConfigured = () => Boolean(process.env.SUPABASE_SECRET_KEY);

const siteUrl = () => (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");

/**
 * The workspace behind a public booking link, or null when it doesn't exist
 * or its plan doesn't include bookings right now.
 */
export async function getPublicWorkspace(
  slug: string,
  admin: SupabaseClient = getAdminClient(),
): Promise<PublicWorkspace | null> {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const { data } = await admin
    .from("tenants")
    .select("id, name, slug, timezone, currency")
    .eq("slug", slug)
    .maybeSingle();
  const tenant = data as PublicWorkspace | null;
  if (!tenant) return null;
  return (await moduleOpen(tenant.id, "bookings", admin)) ? tenant : null;
}

export async function listPublicServices(tenantId: string): Promise<ServiceRow[]> {
  return withTenant(tenantId, async (scope) => {
    const { data, error } = await scope
      .select("services", SERVICE_COLUMNS)
      .eq("active", true)
      .order("name");
    if (error) throw new Error(`Could not load services: ${error.message}`);
    return (data ?? []) as unknown as ServiceRow[];
  });
}

export async function getPublicService(tenantId: string, slug: string): Promise<ServiceRow | null> {
  return withTenant(tenantId, async (scope) => {
    const { data } = await scope
      .select("services", SERVICE_COLUMNS)
      .eq("slug", slug)
      .eq("active", true)
      .maybeSingle();
    return data as unknown as ServiceRow | null;
  });
}

export async function getSessionAvailability(
  tenantId: string,
  serviceId: string,
): Promise<SessionAvailability[]> {
  const { data, error } = await getAdminClient().rpc("session_availability", {
    p_tenant_id: tenantId,
    p_service_id: serviceId,
  });
  if (error) throw new Error(`Could not load sessions: ${error.message}`);
  return (data ?? []) as SessionAvailability[];
}

async function slotInputs(tenant: PublicWorkspace, service: ServiceRow, now: Date) {
  const admin = getAdminClient();
  const rules = await withTenant(tenant.id, async (scope) => {
    const { data } = await scope
      .select("availability_rules", "weekday, start_minute, end_minute")
      .eq("service_id", service.id);
    return (data ?? []) as unknown as AvailabilityRule[];
  });
  const { data: busy, error } = await admin.rpc("busy_appointment_times", {
    p_tenant_id: tenant.id,
    p_from: now.toISOString(),
    p_to: new Date(now.getTime() + (BOOKING_WINDOW_DAYS + 2) * 86_400_000).toISOString(),
  });
  if (error) throw new Error(`Could not load booked times: ${error.message}`);
  return {
    rules,
    busy: (busy ?? []) as Busy[],
    durationMinutes: service.duration_minutes,
    timeZone: tenant.timezone,
    now,
  };
}

export async function getAppointmentSlots(tenant: PublicWorkspace, service: ServiceRow) {
  const inputs = await slotInputs(tenant, service, new Date());
  return generateSlots({ ...inputs, days: BOOKING_WINDOW_DAYS });
}

export async function getBookingForm(tenantId: string): Promise<BookingForm> {
  return withTenant(tenantId, async (scope) => {
    const { data } = await scope
      .select("configs", "body")
      .eq("module", BOOKINGS_MODULE)
      .eq("key", FORM_KEY)
      .maybeSingle();
    return parseBookingForm((data as { body?: unknown } | null)?.body);
  });
}

export async function getBookingEmails(tenantId: string): Promise<BookingEmails> {
  return withTenant(tenantId, async (scope) => {
    const { data } = await scope
      .select("configs", "body")
      .eq("module", BOOKINGS_MODULE)
      .eq("key", EMAILS_KEY)
      .maybeSingle();
    return parseBookingEmails((data as { body?: unknown } | null)?.body);
  });
}

/** The business's own words for its booking emails, and where replies go. */
export async function getEmailWords(tenantId: string): Promise<EmailWords> {
  return withTenant(tenantId, async (scope) => {
    const { data } = await scope
      .select("configs", "body")
      .eq("module", BOOKINGS_MODULE)
      .eq("key", WORDS_KEY)
      .maybeSingle();
    return parseEmailWords((data as { body?: unknown } | null)?.body);
  });
}

/** The Stripe account a workspace takes booking payments into, once it can charge. */
export async function getPayoutAccount(
  tenantId: string,
  admin: SupabaseClient = getAdminClient(),
): Promise<{ account: string; ready: boolean } | null> {
  return withTenant(
    tenantId,
    async (scope) => {
      const { data } = await scope
        .select("connections", "external_account_id, metadata")
        .eq("provider", "stripe")
        .eq("status", "active")
        .maybeSingle();
      const row = data as {
        external_account_id: string;
        metadata: { charges_enabled?: boolean } | null;
      } | null;
      if (!row) return null;
      return { account: row.external_account_id, ready: row.metadata?.charges_enabled !== false };
    },
    admin,
  );
}

/**
 * Like getPayoutAccount, but when our stored note says the account can't
 * take payments yet it asks Stripe for the current answer. Stripe often
 * finishes checking a new account minutes after it connects, and a business
 * shouldn't stay closed for a day waiting for the next scheduled check.
 */
export async function getLivePayoutAccount(
  tenantId: string,
  admin: SupabaseClient = getAdminClient(),
): Promise<{ account: string; ready: boolean } | null> {
  const stored = await getPayoutAccount(tenantId, admin);
  if (!stored || stored.ready || !process.env.STRIPE_SECRET_KEY) return stored;
  try {
    const account = await getStripe().accounts.retrieve(stored.account);
    if (!account.charges_enabled) return stored;
    await withTenant(
      tenantId,
      async (scope) => {
        const { data } = await scope
          .select("connections", "id")
          .eq("provider", "stripe")
          .eq("status", "active")
          .maybeSingle();
        const id = (data as { id?: string } | null)?.id;
        if (id) {
          await admin.rpc("update_connection_details", {
            p_connection_id: id,
            p_display_name: null,
            p_metadata: { charges_enabled: true },
          });
        }
      },
      admin,
    );
    return { account: stored.account, ready: true };
  } catch (err) {
    console.error("Could not check the Stripe account", err instanceof Error ? err.message : err);
    return stored;
  }
}

export async function getBookingDetails(
  by: { tenantId: string; bookingId: string } | { token: string },
  admin: SupabaseClient = getAdminClient(),
): Promise<BookingDetails | null> {
  const { data, error } = await admin.rpc("booking_details", {
    p_tenant_id: "token" in by ? null : by.tenantId,
    p_booking_id: "token" in by ? null : by.bookingId,
    p_manage_token: "token" in by ? by.token : null,
  });
  if (error) throw new Error(`Could not load booking: ${error.message}`);
  const details = ((data ?? []) as BookingDetails[])[0] ?? null;
  if (!details) return null;
  // Where a workshop happens, for the emails and the booking page. A booking
  // without it still goes out, so a failed read is no reason to stop.
  try {
    const place = await withTenant(
      details.tenant_id,
      async (scope) =>
        (await scope.select("services", "location").eq("id", details.service_id).maybeSingle())
          .data as { location?: string } | null,
      admin,
    );
    return { ...details, location: place?.location ?? "" };
  } catch {
    return details;
  }
}

/** Tells the customer they're booked, and lets the workspace's owners know. */
export async function announceBooking(
  details: BookingDetails,
  manageToken: string,
  admin: SupabaseClient = getAdminClient(),
): Promise<void> {
  const site = siteUrl();
  const { confirmation_note, paused } = await getBookingEmails(details.tenant_id);
  // While messages to customers are paused the "you're booked" email is held,
  // and never sent later; a person can press "Send the confirmation again".
  // Its text is queued as usual and the database holds that one.
  if (manageToken && !paused) {
    const words = await getEmailWords(details.tenant_id);
    await sendEmail(
      bookingEmail("confirmation", details, words, {
        link: manageUrl(site, manageToken),
        note: confirmation_note,
      }),
    );
  }
  // The text, for someone who asked for texts, where the workspace sends one.
  await queueBookingText(admin, details.tenant_id, details.booking_id, "confirmation");
  const { data: owners } = await admin.rpc("tenant_owner_emails", {
    p_tenant_id: details.tenant_id,
  });
  const roster = `${site}/w/${details.workspace_slug}/bookings/sessions/${details.session_id}`;
  await postAlert(
    admin,
    details.tenant_id,
    "bookings",
    `${details.customer_name} booked ${details.service_name} for ${formatWhen(details.starts_at, details.ends_at, details.timezone)}${details.seats > 1 ? ` (${details.seats} places)` : ""}.${details.oversold ? " This one arrived after the date had filled, so it's over its limit." : ""}`,
  );
  for (const { email } of (owners ?? []) as { email: string }[]) {
    await sendEmail(ownerNoticeEmail(details, email, roster));
  }
}

export type ReserveInput = {
  tenant: PublicWorkspace;
  service: ServiceRow;
  /** A workshop session, or null with `startsAt` for an appointment. */
  sessionId: string | null;
  startsAt: string | null;
  name: string;
  email: string;
  seats: number;
  answers: Record<string, string>;
  /** A mobile number and the text tick, where the workspace offers texts. */
  text?: { phone: string; agreed: boolean };
};

export type ShopBookingDates = {
  workspace: { name: string; timezone: string };
  service: {
    name: string;
    duration_minutes: number;
    variant_id: string | null;
    /** Where it happens; empty when the business hasn't said. */
    location?: string;
  };
  /** `zone` is the short label for the workspace's clock at that moment ("ET"). */
  sessions: { id: string; starts_at: string; seats_left: number; zone: string }[];
  /** The business's own settings for the picker, and where a shopper can turn. */
  page: ShopPageFacts;
  /** Whether to offer text reminders, and the words beside the tick box. */
  texts: TextOffer;
};

/** Whether our booking pages offer text reminders, and the words beside the tick. */
export function getTextOffer(tenantId: string): Promise<TextOffer> {
  return textOffer(tenantId);
}

export async function getShopPage(tenantId: string): Promise<ShopPage> {
  return withTenant(tenantId, async (scope) => {
    const { data } = await scope
      .select("configs", "body")
      .eq("module", BOOKINGS_MODULE)
      .eq("key", SHOP_PAGE_KEY)
      .maybeSingle();
    return parseShopPage((data as { body?: unknown } | null)?.body);
  });
}

const upcomingMemo = new Map<string, { at: number; answer: UpcomingAnswer | null }>();
const UPCOMING_MEMO_MS = 30_000;

/**
 * The "Upcoming classes" list for a shop's workshops page, or null when the
 * workspace hasn't switched it on (or has no bookings). Kept for half a
 * minute per server, on top of the browser's and the edge's own caching, so a
 * busy shop page never turns into a busy database.
 */
export async function getUpcomingClasses(
  slug: string,
  admin: SupabaseClient = getAdminClient(),
  now: number = Date.now(),
): Promise<UpcomingAnswer | null> {
  const memo = upcomingMemo.get(slug);
  if (memo && now - memo.at < UPCOMING_MEMO_MS) return memo.answer;
  const tenant = await getPublicWorkspace(slug, admin);
  let answer: UpcomingAnswer | null = null;
  if (tenant) {
    const settings = await withTenant(tenant.id, async (scope) => {
      const { data } = await scope
        .select("configs", "body")
        .eq("module", BOOKINGS_MODULE)
        .eq("key", UPCOMING_KEY)
        .maybeSingle();
      return parseUpcoming((data as { body?: unknown } | null)?.body);
    });
    if (settings.on) {
      const page = await getShopPage(tenant.id);
      const { data, error } = await admin.rpc("shop_upcoming_classes", {
        p_tenant_id: tenant.id,
        p_cutoff_hours: page.cutoff_hours,
        p_limit: settings.max_dates,
      });
      if (error) throw new Error(`Could not load upcoming classes: ${error.message}`);
      answer = upcomingAnswer(settings, page, (data ?? []) as UpcomingRow[], tenant.timezone);
    }
  }
  if (upcomingMemo.size > 500) upcomingMemo.clear();
  upcomingMemo.set(slug, { at: now, answer });
  return answer;
}

/**
 * What the date picker on a shop's product page shows: the workshop sold by
 * that product and its coming dates. Null when there is no such workshop
 * (or no such workspace, or its plan doesn't include bookings right now).
 */
export async function getShopBookingDates(
  slug: string,
  productId: string,
  admin: SupabaseClient = getAdminClient(),
  deps: {
    page?: (tenantId: string) => Promise<ShopPage>;
    texts?: (tenantId: string) => Promise<TextOffer>;
  } = {},
): Promise<ShopBookingDates | null> {
  if (!/^[0-9]{1,20}$/.test(productId)) return null;
  const tenant = await getPublicWorkspace(slug, admin);
  if (!tenant) return null;
  const { data, error } = await admin.rpc("shop_booking_dates", {
    p_tenant_id: tenant.id,
    p_product_id: productId,
  });
  if (error) throw new Error(`Could not load dates: ${error.message}`);
  const found = data as {
    service: ShopBookingDates["service"];
    sessions: { id: string; starts_at: string; seats_left: number }[];
  } | null;
  if (!found?.service) return null;
  const [page, texts] = await Promise.all([
    (deps.page ?? getShopPage)(tenant.id),
    (deps.texts ?? ((id: string) => textOffer(id, admin)))(tenant.id),
  ]);
  return {
    workspace: { name: tenant.name, timezone: tenant.timezone },
    service: found.service,
    sessions: found.sessions.map((s) => ({ ...s, zone: zoneLabel(tenant.timezone, s.starts_at) })),
    page: shopPageFacts(page),
    texts,
  };
}

export type ReserveResult =
  | { ok: true; redirectTo: string }
  | { ok: false; reason: "full" | "taken" | "gone" | "payments_off" | "failed" };

/**
 * Takes a booking from the public form: holds the seats, then either confirms
 * (free) or sends the customer to pay on the business's own Stripe account.
 */
export async function reserve(input: ReserveInput): Promise<ReserveResult> {
  const admin = getAdminClient();
  const { tenant, service } = input;
  // Sold in the shop: the shop takes the payment, so nothing is booked here.
  if (service.shop_product_id) return { ok: false, reason: "gone" };
  const paid = service.price_cents > 0;
  const payout = paid ? await getLivePayoutAccount(tenant.id, admin) : null;
  if (paid && (!payout?.ready || !process.env.STRIPE_SECRET_KEY)) {
    return { ok: false, reason: "payments_off" };
  }

  if (service.kind === "appointment") {
    if (!input.startsAt) return { ok: false, reason: "gone" };
    const inputs = await slotInputs(tenant, service, new Date());
    if (!isOfferedSlot(input.startsAt, inputs)) return { ok: false, reason: "taken" };
  } else if (!input.sessionId) {
    return { ok: false, reason: "gone" };
  }

  const token = randomBytes(24).toString("base64url");
  const { data, error } = await admin.rpc("hold_booking", {
    p_tenant_id: tenant.id,
    p_session_id: service.kind === "workshop" ? input.sessionId : null,
    p_service_id: service.id,
    p_starts_at: service.kind === "appointment" ? input.startsAt : null,
    p_name: input.name,
    p_email: input.email,
    p_seats: service.kind === "appointment" ? 1 : input.seats,
    p_answers: input.answers,
    p_manage_token: token,
    p_hold_minutes: HOLD_MINUTES,
  });
  if (error) {
    if (error.message.includes("full")) return { ok: false, reason: "full" };
    if (error.message.includes("taken")) return { ok: false, reason: "taken" };
    if (error.code === "P0001" || error.code === "P0002") return { ok: false, reason: "gone" };
    console.error(`hold_booking failed: ${error.message}`);
    return { ok: false, reason: "failed" };
  }
  const booking = data as {
    id: string;
    session_id: string;
    amount_cents: number;
    currency: string;
  };
  const site = siteUrl();
  // The number and tick go on the booking before anything is sent about it.
  if (input.text) await saveTextConsent(admin, tenant.id, booking.id, input.text);

  if (!paid || !payout) {
    const details = await getBookingDetails({ tenantId: tenant.id, bookingId: booking.id }, admin);
    if (details) await announceBooking(details, token, admin);
    return { ok: true, redirectTo: `${manageUrl(site, token)}?new=1` };
  }

  try {
    const checkout = await getStripe().checkout.sessions.create(
      {
        mode: "payment",
        customer_email: input.email,
        line_items: [
          {
            quantity: service.kind === "appointment" ? 1 : input.seats,
            price_data: {
              currency: booking.currency.toLowerCase(),
              unit_amount: service.price_cents,
              product_data: { name: service.name },
            },
          },
        ],
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60,
        success_url: `${site}/booking/paid?w=${tenant.slug}&checkout={CHECKOUT_SESSION_ID}`,
        cancel_url: `${site}/book/${tenant.slug}/${service.slug}?notice=cancelled`,
        metadata: { tenant_id: tenant.id, booking_id: booking.id, manage_token: token },
        payment_intent_data: { metadata: { tenant_id: tenant.id, booking_id: booking.id } },
      },
      { stripeAccount: payout.account },
    );
    if (!checkout.url) throw new Error("Stripe returned no checkout link");
    const { error: attachError } = await admin.rpc("attach_checkout", {
      p_tenant_id: tenant.id,
      p_booking_id: booking.id,
      p_checkout_session_id: checkout.id,
    });
    if (attachError) throw new Error(attachError.message);
    return { ok: true, redirectTo: checkout.url };
  } catch (err) {
    console.error("Could not start checkout", err instanceof Error ? err.message : err);
    await admin.rpc("release_booking", { p_tenant_id: tenant.id, p_booking_id: booking.id });
    return { ok: false, reason: "failed" };
  }
}

/** The real thing behind `confirmCheckout` and friends. */
export function livePaymentDeps(
  admin: SupabaseClient = getAdminClient(),
  stripe: () => Stripe = getStripe,
): PaymentDeps {
  const must = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };
  return {
    async retrieveCheckout(checkoutId, account): Promise<CheckoutInfo> {
      const session = await stripe().checkout.sessions.retrieve(
        checkoutId,
        {},
        { stripeAccount: account },
      );
      return {
        id: session.id,
        payment_status: session.payment_status,
        payment_intent:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : (session.payment_intent?.id ?? null),
        metadata: session.metadata ?? {},
      };
    },
    payoutAccountFor: async (tenantId) =>
      (await getPayoutAccount(tenantId, admin))?.account ?? null,
    checkoutIdFor: (tenantId, bookingId) =>
      withTenant(
        tenantId,
        async (scope) => {
          const { data } = await scope
            .select("bookings", "stripe_checkout_session_id")
            .eq("id", bookingId)
            .maybeSingle();
          return (
            (data as { stripe_checkout_session_id: string | null } | null)
              ?.stripe_checkout_session_id ?? null
          );
        },
        admin,
      ),
    async confirm(tenantId, bookingId, paymentIntent) {
      const { data, error } = await admin.rpc("confirm_booking", {
        p_tenant_id: tenantId,
        p_booking_id: bookingId,
        p_payment_intent_id: paymentIntent,
      });
      must("Could not confirm booking", error);
      return data === true;
    },
    async release(tenantId, bookingId) {
      const { error } = await admin.rpc("release_booking", {
        p_tenant_id: tenantId,
        p_booking_id: bookingId,
      });
      must("Could not release booking", error);
    },
    details: (tenantId, bookingId) => getBookingDetails({ tenantId, bookingId }, admin),
    announce: (details, token) => announceBooking(details, token, admin),
  };
}

/** Cancels from the customer's link and tells anyone waiting for a place. */
export async function cancelByToken(token: string): Promise<"cancelled" | "too_late" | "missing"> {
  const admin = getAdminClient();
  const details = await getBookingDetails({ token }, admin);
  if (!details) return "missing";
  const { data, error } = await admin.rpc("cancel_booking_by_token", { p_manage_token: token });
  if (error) return error.code === "P0002" ? "missing" : "too_late";
  const link = `${siteUrl()}/book/${details.workspace_slug}`;
  for (const entry of (data ?? []) as { customer_name: string; customer_email: string }[]) {
    await sendEmail(waitlistEmail(entry, details, link));
  }
  return "cancelled";
}

export async function moveByToken(
  token: string,
  sessionId: string,
): Promise<"moved" | "full" | "unavailable"> {
  const admin = getAdminClient();
  // Read before moving: afterwards the booking points at its new date.
  const before = await getBookingDetails({ token }, admin);
  const { data, error } = await admin.rpc("move_booking_by_token", {
    p_manage_token: token,
    p_new_session_id: sessionId,
  });
  if (error) return error.message.includes("full") ? "full" : "unavailable";
  if (before) {
    const link = `${siteUrl()}/book/${before.workspace_slug}`;
    for (const entry of (data ?? []) as { customer_name: string; customer_email: string }[]) {
      await sendEmail(waitlistEmail(entry, before, link));
    }
  }
  return "moved";
}

export async function joinWaitlist(input: {
  tenantId: string;
  sessionId: string;
  name: string;
  email: string;
  seats: number;
}): Promise<boolean> {
  const { error } = await getAdminClient().rpc("join_waitlist", {
    p_tenant_id: input.tenantId,
    p_session_id: input.sessionId,
    p_name: input.name,
    p_email: input.email,
    p_seats: input.seats,
  });
  return !error;
}
