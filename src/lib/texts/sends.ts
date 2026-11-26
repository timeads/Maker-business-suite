import type { SupabaseClient } from "@supabase/supabase-js";
import type { BookingDetails } from "../bookings/emails";
import { getBookingDetails } from "../bookings/server";
import { formatWhen } from "../bookings/slots";
import { postAlert } from "../messages/alerts";
import { featureOpen } from "../module-access";
import { withTenant } from "../supabase/admin";
import { getTwilioAccess } from "./access";
import { readTextSettings } from "./read";
import type { TextKind, TextSettings } from "./config";
import { toE164 } from "./phone";
import { createTwilioClient, type TextDelivery, type TwilioAccess } from "./twilio-client";
import { textFor } from "./words";

/**
 * The booking texts that go out by themselves. The database decides what is
 * due and hands each one out once (`claim_booking_text_sends`); this tries it
 * once and writes down how it went (`finish_booking_text_send`), like the
 * booking emails. A refusal is tried again later by the database's own
 * count; a text we never heard back about is "unsure" and never sent again
 * without a person. Nothing is stamped before it is sent.
 *
 * FIXED WORDS ONLY: the words are the business's own (or ours), filled in by
 * `textFor`. No model is asked anything on this path (guard.test.ts).
 */

type Claim = { send_id: string; booking_id: string; tenant_id: string; kind: TextKind };
type Finished = { status: string; final: boolean; changed: boolean };
type Outcome = Pick<TextDelivery, "outcome" | "detail"> & { sid?: string };

const KIND_WORDS: Record<TextKind, string> = {
  confirmation: "booking text",
  reminder: "reminder text",
  day_of: "day-of reminder text",
  followup: "thank-you text",
  cancelled: "cancellation text",
  moved: "text about the new date",
};

/** What the worker needs about the person, beyond the booking's details. */
export type TextTarget = { phone: string; opt_in: boolean; created_at: string };

export type TextSendDeps = {
  open?: (tenantId: string) => Promise<boolean>;
  details?: (
    by: { tenantId: string; bookingId: string },
    admin: SupabaseClient,
  ) => Promise<BookingDetails | null>;
  settings?: (tenantId: string) => Promise<TextSettings>;
  target?: (tenantId: string, bookingId: string) => Promise<TextTarget | null>;
  /** When the number last replied STOP to this workspace, if ever. */
  optedOut?: (tenantId: string, phone: string) => Promise<string | null>;
  access?: (tenantId: string) => Promise<TwilioAccess>;
  send?: (access: TwilioAccess, to: string, body: string) => Promise<TextDelivery>;
  alert?: typeof postAlert;
};

function liveDeps(admin: SupabaseClient): Required<TextSendDeps> {
  return {
    open: (tenantId) => featureOpen(tenantId, "texts", admin),
    details: getBookingDetails,
    settings: (tenantId) => readTextSettings(tenantId, admin),
    target: (tenantId, bookingId) =>
      withTenant(
        tenantId,
        async (scope) => {
          const { data } = await scope
            .select("bookings", "customer_phone, text_opt_in, created_at")
            .eq("id", bookingId)
            .maybeSingle();
          const row = data as {
            customer_phone: string;
            text_opt_in: boolean;
            created_at: string;
          } | null;
          return row
            ? { phone: row.customer_phone, opt_in: row.text_opt_in, created_at: row.created_at }
            : null;
        },
        admin,
      ),
    optedOut: (tenantId, phone) =>
      withTenant(
        tenantId,
        async (scope) =>
          (
            (
              await scope
                .select("booking_text_opt_outs", "opted_out_at")
                .eq("phone", phone)
                .maybeSingle()
            ).data as { opted_out_at: string } | null
          )?.opted_out_at ?? null,
        admin,
      ),
    access: (tenantId) => getTwilioAccess(tenantId),
    send: (access, to, body) => createTwilioClient(access).sendText(to, body),
    alert: postAlert,
  };
}

/** One claimed text, as far as Twilio, and how it went. Never throws. */
async function tryOne(
  claim: Claim,
  admin: SupabaseClient,
  deps: Required<TextSendDeps>,
  cache: Map<string, TextSettings>,
) {
  let about: BookingDetails | null = null;
  let outcome: Outcome;
  try {
    if (!(await deps.open(claim.tenant_id))) {
      return {
        about,
        outcome: {
          outcome: "rejected" as const,
          detail: "Text reminders aren't part of this workspace's plan right now.",
        },
      };
    }
    about = await deps.details({ tenantId: claim.tenant_id, bookingId: claim.booking_id }, admin);
    const target = await deps.target(claim.tenant_id, claim.booking_id);
    if (!about || !target) {
      return {
        about,
        outcome: { outcome: "rejected" as const, detail: "The booking is no longer there." },
      };
    }
    if (!cache.has(claim.tenant_id))
      cache.set(claim.tenant_id, await deps.settings(claim.tenant_id));
    const settings = cache.get(claim.tenant_id)!;
    if (!target.opt_in) {
      return {
        about,
        outcome: { outcome: "rejected" as const, detail: "They no longer want texts." },
      };
    }
    const to = toE164(target.phone, settings.default_country);
    if (!to) {
      return {
        about,
        outcome: {
          outcome: "rejected" as const,
          detail: "We couldn't read the number they gave as a mobile number, so nothing was sent.",
        },
      };
    }
    const stopped = await deps.optedOut(claim.tenant_id, to);
    if (stopped && Date.parse(stopped) >= Date.parse(target.created_at)) {
      return {
        about,
        outcome: {
          outcome: "rejected" as const,
          detail: "They replied STOP, so nothing was sent.",
        },
      };
    }
    const access = await deps.access(claim.tenant_id);
    // Everything up to here can be tried again; only `send` reaches Twilio.
    const delivery = await deps.send(access, to, textFor(claim.kind, about, settings));
    outcome =
      delivery.outcome === "sent"
        ? { outcome: "sent", detail: "", sid: delivery.sid }
        : { outcome: delivery.outcome, detail: delivery.detail };
  } catch (err) {
    console.error(
      `booking text ${claim.kind} ${claim.booking_id}:`,
      err instanceof Error ? err.message : "unknown",
    );
    outcome = { outcome: "refused", detail: "We couldn't get the text ready to send." };
  }
  return { about, outcome };
}

/** Sends what is due. Returns how many texts went. */
export async function drainBookingTexts(
  admin: SupabaseClient,
  overrides: TextSendDeps = {},
): Promise<number> {
  const deps = { ...liveDeps(admin), ...overrides } as Required<TextSendDeps>;
  const { data, error } = await admin.rpc("claim_booking_text_sends", { p_limit: 50 });
  if (error) throw new Error(`Could not claim booking texts: ${error.message}`);
  const cache = new Map<string, TextSettings>();
  let sent = 0;

  for (const claim of (data ?? []) as Claim[]) {
    const { about, outcome } = await tryOne(claim, admin, deps, cache);
    // If this write fails the claim is left as it is, and the database marks
    // it "unsure" later: we can't know it was recorded, so it isn't resent.
    const { data: done, error: finishError } = await admin.rpc("finish_booking_text_send", {
      p_send_id: claim.send_id,
      p_outcome: outcome.outcome,
      p_detail: outcome.detail,
      p_provider_id: outcome.sid ?? null,
    });
    if (finishError) {
      console.error(`Could not record booking text ${claim.kind}: ${finishError.message}`);
      continue;
    }
    const finished = done as Finished;
    if (finished.status === "sent") sent += 1;
    else if (finished.final && finished.changed && about && outcome.outcome !== "rejected") {
      const who = `${about.customer_name} (${about.service_name}, ${formatWhen(about.starts_at, about.ends_at, about.timezone)})`;
      await deps.alert(
        admin,
        claim.tenant_id,
        "bookings",
        finished.status === "unsure"
          ? `We're not sure the ${KIND_WORDS[claim.kind]} to ${who} went out, so we haven't sent it again.`
          : `The ${KIND_WORDS[claim.kind]} to ${who} couldn't be sent. ${outcome.detail}`,
      );
    }
  }
  if (sent) console.log(`sent ${sent} booking text(s)`);
  return sent;
}
