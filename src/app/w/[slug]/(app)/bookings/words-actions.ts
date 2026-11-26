"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { BOOKINGS_MODULE } from "@/lib/bookings/config";
import { readEmailSettings } from "@/lib/bookings/email-settings";
import {
  MESSAGE_KEYS,
  WORDS_KEY,
  bookingEmail,
  emailWordsSchema,
  noteFor,
  sampleBooking,
  sampleExtras,
  sampleStartsAt,
  unknownFillIns,
  type EmailWords,
  type MessageKey,
} from "@/lib/bookings/words";
import { deliverEmail, emailConfigured } from "@/lib/email";
import { getEntitlements } from "@/lib/entitlements";
import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import type { BookingsState } from "./actions";

const NO_ACCESS = "Bookings aren't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can change these emails.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't save. Please try again.";

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/settings/bookings/words`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.bookings")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  if (!canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  return { user, tenant: ctx.tenant, supabase: await createClient() } as const;
}
type Ctx = Exclude<Awaited<ReturnType<typeof context>>, { error: string }>;

const isKey = (key: string): key is MessageKey => (MESSAGE_KEYS as readonly string[]).includes(key);

/** The words in the form, checked the way they are checked when saved. */
function readWords(
  key: MessageKey,
  formData: FormData,
): { subject: string; body: string } | { error: string } {
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!subject) return { error: "Give the email a subject." };
  if (subject.length > 200) return { error: "Keep the subject under 200 characters." };
  if (/[\r\n]/.test(subject)) return { error: "The subject has to fit on one line." };
  if (!body) return { error: "Write what the email says." };
  if (body.length > 5000) return { error: "Keep the email under 5,000 characters." };
  const unknown = unknownFillIns(key, `${subject}\n${body}`);
  if (unknown.length) {
    return {
      error: `This email can't fill in ${unknown.map((u) => `{{${u}}}`).join(", ")}. Use one from the list beside it.`,
    };
  }
  return { subject, body };
}

async function save(ctx: Ctx, slug: string, next: EmailWords): Promise<BookingsState | null> {
  const parsed = emailWordsSchema.safeParse(next);
  if (!parsed.success) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: BOOKINGS_MODULE,
    p_key: WORDS_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  revalidatePath(`/w/${slug}/settings`, "layout");
  revalidatePath(`/w/${slug}/bookings`, "layout");
  return null;
}

/** Saves one message's words, or puts our words back ("reset"). */
export async function saveMessageWords(
  slug: string,
  key: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!isKey(key)) return { error: OOPS };
  const { words } = await readEmailSettings(ctx.supabase, ctx.tenant.id);
  const messages = { ...words.messages };
  if (formData.get("intent") === "reset") {
    delete messages[key];
  } else {
    const read = readWords(key, formData);
    if ("error" in read) return read;
    messages[key] = read;
  }
  const failed = await save(ctx, slug, { ...words, messages });
  if (failed) return failed;
  return {
    message:
      formData.get("intent") === "reset"
        ? "Back to our words."
        : "Saved. It goes out like this from now on.",
  };
}

/** Where customers' replies go. Empty: the mail service's own address. */
export async function saveReplyTo(
  slug: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const replyTo = String(formData.get("reply_to") ?? "").trim();
  if (replyTo && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(replyTo)) {
    return { error: "That email address doesn't look right." };
  }
  const { words } = await readEmailSettings(ctx.supabase, ctx.tenant.id);
  const failed = await save(ctx, slug, { ...words, reply_to: replyTo });
  if (failed) return failed;
  return {
    message: replyTo ? `Saved. Replies now go to ${replyTo}.` : "Saved. Replies go to our address.",
  };
}

/**
 * Sends the words in the form, filled with the made-up booking, to the
 * signed-in person's own address and nowhere else. Nothing is saved.
 */
export async function sendTestEmail(
  slug: string,
  key: string,
  _prev: BookingsState,
  formData: FormData,
): Promise<BookingsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!isKey(key)) return { error: OOPS };
  const to = ctx.user.email;
  if (!to) return { error: "Your sign-in has no email address to send to." };
  if (!emailConfigured())
    return { error: "Email isn't switched on here yet, so nothing was sent." };
  const read = readWords(key, formData);
  if ("error" in read) return read;
  const { timing, words } = await readEmailSettings(ctx.supabase, ctx.tenant.id);
  const sample = sampleBooking({
    workspaceName: ctx.tenant.name,
    timezone: ctx.tenant.timezone,
    serviceName: String(formData.get("sample_workshop") ?? "").slice(0, 120),
    location: String(formData.get("sample_place") ?? "").slice(0, 200),
    startsAt: sampleStartsAt(new Date(), ctx.tenant.timezone),
  });
  const email = bookingEmail(
    key,
    { ...sample, customer_email: to },
    { ...words, messages: { ...words.messages, [key]: read } },
    sampleExtras(key, sample, await getSiteUrl(), noteFor(key, timing)),
  );
  const delivery = await deliverEmail({ ...email, to, subject: `[Test] ${email.subject}` });
  return delivery.outcome === "sent"
    ? { message: `Sent to ${to}. It uses a made-up booking.` }
    : { error: `It didn't go. ${delivery.detail}` };
}
