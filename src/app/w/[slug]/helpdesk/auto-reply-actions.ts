"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { getEntitlements } from "@/lib/entitlements";
import { AUTO_REPLIES_KEY, parseAutoReplies } from "@/lib/helpdesk/auto-reply/config";
import { previewWords, readAutoReplyForm } from "@/lib/helpdesk/auto-reply/form";
import { HELPDESK_MODULE } from "@/lib/helpdesk/config";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import type { HelpdeskState } from "./actions";

/**
 * Settings → Help desk → Automatic replies. The words saved here are the
 * only words the help desk ever sends by itself: nothing on this screen, and
 * nothing that sends them, asks a model for anything.
 */

async function managerContext(slug: string) {
  const user = await requireUser(`/w/${slug}/settings/helpdesk/auto-replies`);
  const ctx = await getTenantContext(slug, user.id);
  const none = "The help desk isn't part of this workspace's plan right now.";
  if (!ctx) return { error: none } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.helpdesk")) return { error: none } as const;
  if (!entitlements.canWrite) {
    return {
      error: "This workspace is read-only because its plan has ended. Pick a plan to make changes.",
    } as const;
  }
  if (!canManage(ctx.role)) {
    return { error: "Only owners and admins can change automatic replies." } as const;
  }
  return { user, tenant: ctx.tenant, supabase: await createClient() } as const;
}

export async function saveAutoReplies(
  slug: string,
  _prev: HelpdeskState,
  formData: FormData,
): Promise<HelpdeskState> {
  const ctx = await managerContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const read = readAutoReplyForm(
    (name) => {
      const value = formData.get(name);
      return typeof value === "string" ? value : null;
    },
    { businessName: ctx.tenant.name },
  );
  if (!read.ok) return { error: read.error };
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: HELPDESK_MODULE,
    p_key: AUTO_REPLIES_KEY,
    p_body: read.value,
  });
  if (error) return { error: "We couldn't save that. Try again in a moment." };
  revalidatePath(`/w/${slug}/settings`, "layout");
  const on = (["instagram", "facebook", "email"] as const).filter((name) => read.value[name].on);
  return {
    message:
      on.length === 0
        ? "Saved. Nothing is sent by itself while every channel is off."
        : "Saved. It applies to the next message that comes in.",
  };
}

/**
 * Emails the SAVED email reply to the signed-in person's own address, and to
 * nobody else: the address is read from their session, never from the form.
 */
export async function sendAutoReplyTest(
  slug: string,
  _prev: HelpdeskState,
  formData: FormData,
): Promise<HelpdeskState> {
  const ctx = await managerContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const to = ctx.user.email;
  if (!to) return { error: "Your account has no email address to send a test to." };
  const { data } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", HELPDESK_MODULE)
    .eq("key", AUTO_REPLIES_KEY)
    .maybeSingle();
  const saved = parseAutoReplies(data?.body).email;
  const away = formData.get("which") === "away";
  const words = previewWords(away ? saved.away_message : saved.message, ctx.tenant.name);
  if (!words) {
    return {
      error: `There is no saved ${away ? "away message" : "message"} for email yet. Write it, save, then send the test.`,
    };
  }
  const sent = await sendEmail({
    to,
    subject: `Test: ${ctx.tenant.name}'s automatic email reply${away ? " (away message)" : ""}`,
    text: words,
  });
  if (!sent) return { error: "The test couldn't be sent just now. Email may not be set up here." };
  return { message: `Sent to ${to}. Nothing went to any customer.` };
}
