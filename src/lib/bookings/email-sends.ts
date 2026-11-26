import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverEmail, emailConfigured, type Delivery } from "../email";
import { postAlert } from "../messages/alerts";
import type { BookingEmails } from "./config";
import type { BookingDetails, Email } from "./emails";
import { getBookingDetails, getBookingEmails, getEmailWords } from "./server";
import { formatWhen } from "./slots";
import {
  DEFAULT_EMAIL_WORDS,
  bookingEmail,
  noteFor,
  type EmailWords,
  type MessageKey,
} from "./words";

/**
 * The booking emails that go out by themselves: the reminder, the day-of
 * reminder, the thank-you, and the notice that a shop refund cancelled a
 * booking. The database decides what is due and hands each one out once
 * (`claim_booking_email_sends`); this tries it once and writes down how it
 * went (`finish_booking_email_send`). A refusal is tried again later by the
 * database's own count; a send we never heard back about is "unsure" and is
 * never sent again without a person.
 */

export type EmailKind = "reminder" | "day_of" | "followup" | "cancelled";

type Claim = { send_id: string; booking_id: string; tenant_id: string; kind: EmailKind };
type Finished = { status: string; final: boolean; changed: boolean };

const KIND_WORDS: Record<EmailKind, string> = {
  reminder: "reminder",
  day_of: "day-of reminder",
  followup: "thank-you email",
  cancelled: "cancellation email",
};

const MESSAGE: Record<EmailKind, MessageKey> = {
  reminder: "reminder",
  day_of: "day_of",
  followup: "followup",
  cancelled: "shop_cancelled",
};

/** The email for one kind, in the business's own words (ours where it changed nothing). */
export function emailFor(
  kind: EmailKind,
  details: BookingDetails,
  settings: BookingEmails,
  words: EmailWords = DEFAULT_EMAIL_WORDS,
): Email {
  const key = MESSAGE[kind];
  return bookingEmail(key, details, words, { note: noteFor(key, settings) });
}

export type EmailSendDeps = {
  configured?: () => boolean;
  deliver?: (email: Email) => Promise<Delivery>;
  details?: (
    by: { tenantId: string; bookingId: string },
    admin: SupabaseClient,
  ) => Promise<BookingDetails | null>;
  settings?: (tenantId: string) => Promise<BookingEmails>;
  words?: (tenantId: string) => Promise<EmailWords>;
  alert?: typeof postAlert;
};

/** Sends what is due. Returns how many emails went. */
export async function drainBookingEmails(
  admin: SupabaseClient,
  deps: EmailSendDeps = {},
): Promise<number> {
  // With no mail service nothing is claimed, so nothing is used up.
  if (!(deps.configured ?? emailConfigured)()) return 0;
  const deliver = deps.deliver ?? ((email: Email) => deliverEmail(email));
  const details = deps.details ?? getBookingDetails;
  const settings = deps.settings ?? getBookingEmails;
  const loadWords = deps.words ?? getEmailWords;
  const alert = deps.alert ?? postAlert;

  const { data, error } = await admin.rpc("claim_booking_email_sends", { p_limit: 50 });
  if (error) throw new Error(`Could not claim booking emails: ${error.message}`);
  const timing = new Map<string, BookingEmails>();
  const words = new Map<string, EmailWords>();
  let sent = 0;

  for (const claim of (data ?? []) as Claim[]) {
    let about: BookingDetails | null = null;
    let delivery: Delivery;
    try {
      about = await details({ tenantId: claim.tenant_id, bookingId: claim.booking_id }, admin);
      if (!about) {
        delivery = { outcome: "rejected", detail: "The booking is no longer there." };
      } else {
        if (!timing.has(claim.tenant_id)) {
          timing.set(claim.tenant_id, await settings(claim.tenant_id));
          words.set(claim.tenant_id, await loadWords(claim.tenant_id));
        }
        // Everything up to here can be tried again; only `deliver` reaches the mail service.
        delivery = await deliver(
          emailFor(
            claim.kind,
            about,
            timing.get(claim.tenant_id)!,
            words.get(claim.tenant_id) ?? DEFAULT_EMAIL_WORDS,
          ),
        );
        if (delivery.outcome === "off") {
          delivery = { outcome: "refused", detail: "Email isn't set up." };
        }
      }
    } catch (err) {
      console.error(
        `booking ${claim.kind} ${claim.booking_id}:`,
        err instanceof Error ? err.message : err,
      );
      delivery = { outcome: "refused", detail: "We couldn't put the email together." };
    }

    // If this write fails the claim is left as it is, and the database marks
    // it "unsure" later: we can't know it was recorded, so it isn't resent.
    const { data: done, error: finishError } = await admin.rpc("finish_booking_email_send", {
      p_send_id: claim.send_id,
      p_outcome: delivery.outcome,
      p_detail: delivery.detail,
    });
    if (finishError) {
      console.error(`Could not record booking ${claim.kind}: ${finishError.message}`);
      continue;
    }
    const finished = done as Finished;
    if (finished.status === "sent") sent += 1;
    else if (finished.final && finished.changed && about) {
      const who = `${about.customer_name} (${about.service_name}, ${formatWhen(about.starts_at, about.ends_at, about.timezone)})`;
      await alert(
        admin,
        claim.tenant_id,
        "bookings",
        finished.status === "unsure"
          ? `We're not sure the ${KIND_WORDS[claim.kind]} to ${who} went out, so we haven't sent it again. You may want to write to them yourself.`
          : `The ${KIND_WORDS[claim.kind]} to ${who} couldn't be sent. ${delivery.detail} You may want to write to them yourself.`,
      );
    }
  }
  if (sent) console.log(`sent ${sent} booking email(s)`);
  return sent;
}
