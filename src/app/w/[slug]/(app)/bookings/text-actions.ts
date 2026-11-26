"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { BOOKINGS_MODULE } from "@/lib/bookings/config";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { getTwilioAccess } from "@/lib/texts/access";
import {
  TEXTS_KEY,
  TEXT_KINDS,
  parseTextSettings,
  textSettingsSchema,
  type TextKind,
} from "@/lib/texts/config";
import { isCountryKey, toE164 } from "@/lib/texts/phone";
import { createTwilioClient } from "@/lib/texts/twilio-client";
import { DEFAULT_TEXTS, sampleBooking, textFor, unknownTextFillIns } from "@/lib/texts/words";
import type { BookingsState } from "./actions";

const NO_ACCESS = "Text reminders aren't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can change text reminders.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't save. Please try again.";

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/settings/bookings/texts`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.bookings") || !entitlements.can("texts")) {
    return { error: NO_ACCESS } as const;
  }
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  if (!canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  return { tenant: ctx.tenant, supabase: await createClient() } as const;
}

const text = (formData: FormData, name: string) =>
  String(formData.get(name) ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
const hours = (formData: FormData, name: string, fallback: number) => {
  const value = Number.parseInt(text(formData, name), 10);
  return Number.isFinite(value) ? value : fallback;
};

/** Saves the text settings and the words. Words left as ours are stored as "ours". */
export async function saveTextSettings(
  slug: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };

  const messages = {} as Record<TextKind, { on: boolean; body: string }>;
  for (const kind of TEXT_KINDS) {
    const body = text(formData, `${kind}_body`);
    const unknown = unknownTextFillIns(body);
    if (unknown.length) {
      return { error: `A text uses a fill-in we don't have: ${unknown.join(", ")}.` };
    }
    messages[kind] = {
      on: formData.get(`${kind}_on`) === "on",
      // Our words, unchanged, stay ours, so they follow any later improvement.
      body: body === DEFAULT_TEXTS[kind] ? "" : body,
    };
  }
  const country = text(formData, "default_country");
  const parsed = textSettingsSchema.safeParse({
    version: 1,
    on: formData.get("on") === "on",
    default_country: isCountryKey(country) ? country : "US",
    consent_words: text(formData, "consent_words"),
    opt_out_line: text(formData, "opt_out_line"),
    reminder_hours: hours(formData, "reminder_hours", 48),
    day_of_hours: hours(formData, "day_of_hours", 2),
    followup_hours: hours(formData, "followup_hours", 24),
    messages,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = String(issue?.path?.[0] ?? "");
    return {
      error:
        where === "opt_out_line"
          ? "The opt-out line has to tell people to reply STOP (in capitals), in 80 characters or fewer."
          : where === "consent_words"
            ? "Write the words beside the tick box, between 10 and 300 characters."
            : where.endsWith("hours")
              ? "Pick the timing again: the reminder up to 14 days ahead, the day-of up to 24 hours, the thank-you up to 7 days after."
              : "Keep each text under 600 characters.",
    };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: BOOKINGS_MODULE,
    p_key: TEXTS_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  revalidatePath(`/w/${slug}/settings`, "layout");
  revalidatePath(`/w/${slug}/bookings`, "layout");
  const on = TEXT_KINDS.filter((kind) => parsed.data.messages[kind].on).length;
  return {
    message: !parsed.data.on
      ? "Saved. Texts are off, and people booking aren't asked for a number."
      : on === 0
        ? "Saved. Texts are on, but no message is ticked yet, so nothing is sent."
        : `Saved. ${on === 1 ? "One message goes" : `${on} messages go`} as a text to people who tick the box.`,
  };
}

/**
 * One test text to a number the person types and says is their own, with a
 * made-up booking. Limited in the database (`claim_test_text`): three an hour
 * per person, ten a day per workspace.
 */
export async function sendTestText(
  slug: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (formData.get("own_number") !== "on") {
    return { error: "Tick the box to say this is your own number. Tests only go to you." };
  }
  const kind = text(formData, "kind") as TextKind;
  if (!TEXT_KINDS.includes(kind)) return { error: OOPS };
  const { data: config } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", BOOKINGS_MODULE)
    .eq("key", TEXTS_KEY)
    .maybeSingle();
  const settings = parseTextSettings(config?.body);
  const to = toE164(text(formData, "phone"), settings.default_country);
  if (!to) {
    return {
      error: "We couldn't read that as a mobile number. Try it with + and the country code.",
    };
  }
  const { data: allowed, error } = await ctx.supabase.rpc("claim_test_text", {
    p_tenant_id: ctx.tenant.id,
  });
  if (error) return { error: OOPS };
  if (allowed !== true) {
    return { error: "That's enough tests for now. Try again in an hour." };
  }
  let access;
  try {
    access = await getTwilioAccess(ctx.tenant.id);
  } catch {
    return { error: "Connect Twilio first, under Connections." };
  }
  const body = textFor(kind, sampleBooking(ctx.tenant.name, ctx.tenant.timezone), settings);
  const delivery = await createTwilioClient(access).sendText(to, `[Test] ${body}`);
  return delivery.outcome === "sent"
    ? { message: "Sent. It uses a made-up booking, and the words as they were last saved." }
    : { error: `It didn't go. ${delivery.detail}` };
}
