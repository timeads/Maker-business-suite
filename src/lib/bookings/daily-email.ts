import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverEmail, emailConfigured, type Delivery } from "../email";
import { moduleOpen } from "../module-access";
import { withTenant } from "../supabase/admin";
import type { Email } from "./emails";
import { formatWhen, zonedTimeToUtc } from "./slots";

/**
 * The owner's daily email (config "bookings" / "daily_email", off unless
 * switched on): today's and tomorrow's classes and how full they are, the
 * bookings made in the last day, and anything that needs a person, after the
 * business's earlier booking app's digest. It goes to the workspace members
 * an owner or admin chose, at the hour they chose on the workspace's clocks.
 *
 * The database decides what is due and hands each person's email for a day
 * out once (`claim_booking_daily_emails`); this puts the words together, tries
 * it once and writes down how it went (`finish_booking_daily_email`). The
 * words are ours and the facts are the workspace's own; no model is involved.
 */
export {
  DAILY_KEY,
  DEFAULT_DAILY_EMAIL,
  dailyEmailSchema,
  hourWords,
  parseDailyEmail,
  type DailyEmailSettings,
} from "./daily-config";

export type DailyClass = {
  service: string;
  starts_at: string;
  ends_at: string;
  taken: number;
  capacity: number;
  cancelled: boolean;
};

export type DailyFacts = {
  business: string;
  timezone: string;
  /** The workspace's calendar day the email is for. */
  day: string;
  today: DailyClass[];
  tomorrow: DailyClass[];
  /** Bookings made in the 24 hours before it was put together. */
  newBookings: {
    name: string;
    service: string;
    starts_at: string;
    ends_at: string;
    seats: number;
  }[];
  /** Upcoming bookings over their date's limit. */
  oversold: number;
  /** Shop orders that paid for a workshop and still wait for a date. */
  needsDate: number;
  link: string;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const dayName = (day: string, offset = 0) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, d + offset, 12)));
};

function classLines(classes: DailyClass[], timezone: string): string[] {
  const live = classes.filter((c) => !c.cancelled);
  if (live.length === 0) return ["Nothing on."];
  return live.map((c) => {
    const over =
      c.taken > c.capacity ? " (over its limit)" : c.taken >= c.capacity ? " (full)" : "";
    return `• ${c.service}, ${formatWhen(c.starts_at, c.ends_at, timezone)}: ${c.taken} of ${plural(c.capacity, "place", "places")} booked${over}`;
  });
}

/** The daily email to one person. Pure: the same facts give the same words. */
export function dailyEmail(facts: DailyFacts, to: string): Email {
  const live = facts.today.filter((c) => !c.cancelled);
  const people = live.reduce((n, c) => n + c.taken, 0);
  const shownNew = facts.newBookings.slice(0, 15);
  const needs = [
    facts.oversold > 0
      ? `• ${plural(facts.oversold, "booking is", "bookings are")} over a date's limit. Its date's page has a button to raise the limit.`
      : "",
    facts.needsDate > 0
      ? `• ${plural(facts.needsDate, "shop order", "shop orders")} paid for a workshop with no date. Bookings → Needs a date.`
      : "",
  ].filter(Boolean);
  return {
    to,
    subject: live.length
      ? `Today at ${facts.business}: ${plural(live.length, "class", "classes")}, ${plural(people, "person", "people")} booked`
      : `Your bookings at ${facts.business}: ${dayName(facts.day)}`,
    text: [
      "Hello,",
      "",
      `Here's your day at ${facts.business}.`,
      "",
      `Today, ${dayName(facts.day)}`,
      ...classLines(facts.today, facts.timezone),
      "",
      `Tomorrow, ${dayName(facts.day, 1)}`,
      ...classLines(facts.tomorrow, facts.timezone),
      "",
      facts.newBookings.length
        ? `New bookings in the last day: ${facts.newBookings.length}`
        : "No new bookings in the last day.",
      ...shownNew.map(
        (b) =>
          `• ${b.name}, ${b.service} on ${formatWhen(b.starts_at, b.ends_at, facts.timezone)}${b.seats > 1 ? ` (${b.seats} places)` : ""}`,
      ),
      ...(facts.newBookings.length > shownNew.length
        ? [`…and ${facts.newBookings.length - shownNew.length} more.`]
        : []),
      ...(needs.length ? ["", "Needs you", ...needs] : []),
      "",
      `See everything: ${facts.link}`,
      "",
      "You get this because an owner or admin chose you for the daily email in Settings → Bookings → Daily email.",
    ].join("\n"),
  };
}

const addDay = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** Reads one workspace's facts for a day with the service role, always naming the workspace. */
export async function loadDailyFacts(
  admin: SupabaseClient,
  tenant: { id: string; name: string; slug: string; timezone: string },
  day: string,
  site: string,
  now: Date = new Date(),
): Promise<DailyFacts> {
  const start = zonedTimeToUtc(day, 0, tenant.timezone);
  const middle = zonedTimeToUtc(addDay(day, 1), 0, tenant.timezone);
  const end = zonedTimeToUtc(addDay(day, 2), 0, tenant.timezone);
  if (!start || !middle || !end) throw new Error("That day doesn't exist here.");
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  return withTenant(
    tenant.id,
    async (scope) => {
      const [dates, fresh, over, undated] = await Promise.all([
        scope
          .select(
            "sessions",
            "starts_at, ends_at, capacity, cancelled_at, services(name), bookings(seats, status)",
          )
          .gte("starts_at", start.toISOString())
          .lt("starts_at", end.toISOString())
          .order("starts_at")
          .limit(200),
        scope
          .select("bookings", "customer_name, seats, sessions(starts_at, ends_at, services(name))")
          .eq("status", "confirmed")
          .gte("created_at", since)
          .order("created_at")
          .limit(200),
        scope
          .select("bookings", "id, sessions!inner(starts_at, cancelled_at)")
          .eq("status", "confirmed")
          .eq("oversold", true)
          .gte("sessions.starts_at", now.toISOString())
          .is("sessions.cancelled_at", null)
          .limit(500),
        scope
          .select("shop_undated_lines", "id")
          .is("booking_id", null)
          .is("dismissed_at", null)
          .gt("seats", 0)
          .eq("order_cancelled", false)
          .limit(500),
      ]);
      if (dates.error || fresh.error) throw new Error("Bookings unreadable");
      const classes = (
        (dates.data ?? []) as unknown as {
          starts_at: string;
          ends_at: string;
          capacity: number;
          cancelled_at: string | null;
          services: { name: string } | null;
          bookings: { seats: number; status: string }[];
        }[]
      ).map((s) => ({
        service: s.services?.name ?? "A class",
        starts_at: s.starts_at,
        ends_at: s.ends_at,
        capacity: s.capacity,
        cancelled: s.cancelled_at !== null,
        taken: s.bookings.filter((b) => b.status === "confirmed").reduce((n, b) => n + b.seats, 0),
      }));
      const tomorrowFrom = middle.toISOString();
      return {
        business: tenant.name,
        timezone: tenant.timezone,
        day,
        today: classes.filter((c) => c.starts_at < tomorrowFrom),
        tomorrow: classes.filter((c) => c.starts_at >= tomorrowFrom),
        newBookings: (
          (fresh.data ?? []) as unknown as {
            customer_name: string;
            seats: number;
            sessions: {
              starts_at: string;
              ends_at: string;
              services: { name: string } | null;
            } | null;
          }[]
        )
          .filter((b) => b.sessions)
          .map((b) => ({
            name: b.customer_name,
            seats: b.seats,
            service: b.sessions!.services?.name ?? "a class",
            starts_at: b.sessions!.starts_at,
            ends_at: b.sessions!.ends_at,
          })),
        // These two are a nudge; a failed read leaves them out, never the email.
        oversold: over.error ? 0 : (over.data ?? []).length,
        needsDate: undated.error ? 0 : (undated.data ?? []).length,
        link: `${site}/w/${tenant.slug}/bookings`,
      };
    },
    admin,
  );
}

type Claim = { send_id: string; tenant_id: string; user_id: string; email: string; day: string };

export type DailyDeps = {
  configured?: () => boolean;
  deliver?: (email: Email) => Promise<Delivery>;
  open?: (tenantId: string) => Promise<boolean>;
  tenant?: (
    tenantId: string,
  ) => Promise<{ id: string; name: string; slug: string; timezone: string } | null>;
  facts?: typeof loadDailyFacts;
  site?: () => string;
};

/** Sends the daily emails that are due. Returns how many went. */
export async function drainDailyEmails(
  admin: SupabaseClient,
  deps: DailyDeps = {},
): Promise<number> {
  // With no mail service nothing is claimed, so no day is used up.
  if (!(deps.configured ?? emailConfigured)()) return 0;
  const deliver = deps.deliver ?? ((email: Email) => deliverEmail(email));
  const open = deps.open ?? ((tenantId: string) => moduleOpen(tenantId, "bookings", admin));
  const tenantOf =
    deps.tenant ??
    (async (tenantId: string) => {
      const { data } = await admin
        .from("tenants")
        .select("id, name, slug, timezone")
        .eq("id", tenantId)
        .maybeSingle();
      return (data as { id: string; name: string; slug: string; timezone: string } | null) ?? null;
    });
  const facts = deps.facts ?? loadDailyFacts;
  const site = (
    deps.site ?? (() => (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, ""))
  )();

  const { data, error } = await admin.rpc("claim_booking_daily_emails", { p_limit: 50 });
  if (error) throw new Error(`Could not claim daily emails: ${error.message}`);
  const made = new Map<string, DailyFacts | null>();
  let sent = 0;
  for (const claim of (data ?? []) as Claim[]) {
    let outcome: Delivery["outcome"] | "skipped";
    let detail = "";
    try {
      const key = `${claim.tenant_id}:${claim.day}`;
      if (!made.has(key)) {
        const tenant = (await open(claim.tenant_id)) ? await tenantOf(claim.tenant_id) : null;
        made.set(key, tenant ? await facts(admin, tenant, claim.day, site) : null);
      }
      const about = made.get(key);
      if (!about) {
        outcome = "skipped";
        detail = "Bookings aren't part of this workspace's plan now.";
      } else {
        // Everything up to here can be tried again; only `deliver` reaches the mail service.
        const delivery = await deliver(dailyEmail(about, claim.email));
        outcome = delivery.outcome === "off" ? "refused" : delivery.outcome;
        detail = delivery.outcome === "off" ? "Email isn't set up." : delivery.detail;
      }
    } catch (err) {
      console.error(`daily email ${claim.send_id}:`, err instanceof Error ? err.message : err);
      outcome = "refused";
      detail = "We couldn't put the email together.";
    }
    const { error: finishError } = await admin.rpc("finish_booking_daily_email", {
      p_send_id: claim.send_id,
      p_outcome: outcome,
      p_detail: detail,
    });
    if (finishError) {
      console.error(`Could not record a daily email: ${finishError.message}`);
      continue;
    }
    if (outcome === "sent") sent += 1;
  }
  if (sent) console.log(`sent ${sent} daily booking email(s)`);
  return sent;
}
