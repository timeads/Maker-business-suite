"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { googleMailConfigured, sendGmail } from "@/lib/connections/providers/google-mail";
import { getAdapter } from "@/lib/connections/registry";
import { getProviderToken, vaultTokenStore } from "@/lib/connections/tokens";
import { ReconnectRequiredError } from "@/lib/connections/types";
import { getEntitlements } from "@/lib/entitlements";
import { STOCK_MODULE } from "@/lib/stock/config";
import { buildPoDocument } from "@/lib/stock/po/document";
import { PO_EMAIL_KEY, parsePoEmail, poEmailSchema, poSnapshot } from "@/lib/stock/po/email";
import { renderPoPdf } from "@/lib/stock/po/pdf";
import { SendRefused, sendPoEmail } from "@/lib/stock/po/send";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { loadPoForSupplier, loadPoLogo, poFileName } from "./po-data";

export type EmailState = { error?: string; message?: string; sent?: boolean };

const NO_ACCESS = "Stock isn't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can do that.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't save. Please try again.";
const NOT_CONNECTED = "Connect Gmail under Connections first.";
const RECONNECT = "Gmail needs reconnecting, under Connections. Nothing was sent.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/stock`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.stock")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  if (!canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  return { tenant: ctx.tenant, supabase: await createClient() } as const;
}

/**
 * Emails one order to its supplier from the workspace's own Gmail, with the
 * PDF attached. Always a manager's own press of the button, after they have
 * seen who it goes to and what it says. The request key the page made means a
 * second press finds the first and sends nothing (lib/stock/po/send.ts).
 */
export async function sendOrderEmail(
  slug: string,
  orderId: string,
  _prev: EmailState,
  formData: FormData,
): Promise<EmailState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { tenant, supabase } = ctx;
  const requestKey = String(formData.get("request_key") ?? "");
  if (!UUID.test(orderId) || !UUID.test(requestKey)) {
    return { error: "That didn't send. Refresh the page and try again." };
  }
  if (!googleMailConfigured()) return { error: NOT_CONNECTED };

  // Which mailbox: read as the member. Nothing secret is in these columns.
  const [{ data: mailbox }, { data: config }, order] = await Promise.all([
    supabase
      .from("connections")
      .select("status, metadata")
      .eq("tenant_id", tenant.id)
      .eq("provider", "google_mail")
      .maybeSingle(),
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", STOCK_MODULE)
      .eq("key", PO_EMAIL_KEY)
      .maybeSingle(),
    loadPoForSupplier(supabase, tenant, { id: orderId }),
  ]);
  if (!order) return { error: "That order can't be found." };
  const senderEmail = String((mailbox?.metadata as { email?: unknown } | null)?.email ?? "");
  if (!mailbox || mailbox.status === "disconnected" || !senderEmail) {
    return { error: NOT_CONNECTED };
  }
  if (mailbox.status !== "active") return { error: RECONNECT };
  const template = parsePoEmail(config?.body);
  const isDraft = order.status === "draft";

  const result = await sendPoEmail(
    {
      requestKey,
      to: String(formData.get("to") ?? ""),
      ccMe: formData.get("cc_me") === "on",
      subject: String(formData.get("subject") ?? ""),
      body: String(formData.get("body") ?? ""),
    },
    {
      sender: { email: senderEmail, name: template.from_name || tenant.name },
      snapshot: poSnapshot(order.forEmail),
      filename: poFileName(order.reference),

      async begin(args) {
        const { data, error } = await supabase.rpc("begin_po_email", {
          p_po_id: order.id,
          p_request_key: args.requestKey,
          p_to: args.to,
          p_cc: args.cc,
          p_subject: args.subject,
          p_sender_email: args.senderEmail,
          p_message_id: args.messageId,
          p_snapshot: args.snapshot,
          p_fingerprint: args.fingerprint,
        });
        const row = (data as Record<string, unknown>[] | null)?.[0];
        if (error || !row) {
          const why = error?.message ?? "";
          throw new SendRefused(
            why.includes("order_cancelled")
              ? "This order was cancelled, so it can't be emailed."
              : why.includes("order_empty")
                ? "Add something to the order before emailing it."
                : why.includes("Bad email")
                  ? "One of those addresses isn't an email address."
                  : why.includes("Only owners and admins")
                    ? NOT_ALLOWED
                    : "That didn't send. Please try again.",
          );
        }
        return {
          id: row.id as string,
          state: row.state as "new" | "retry" | "sent" | "busy" | "unsure",
          threadId: (row.thread_id as string | null) ?? null,
          replyTo: (row.reply_to as string | null) ?? null,
        };
      },

      async renderPdf() {
        // A draft is marked ordered as it goes out, so the PDF already says so.
        const document = isDraft
          ? {
              ...order.document,
              order: {
                ...order.document.order,
                status: "ordered",
                orderedAt: new Date().toISOString(),
              },
            }
          : order.document;
        return renderPoPdf(buildPoDocument(document), await loadPoLogo(supabase, tenant.id));
      },

      // The only place the mailbox's sign-in is read: from Vault, by the
      // workspace this manager was just checked against. It goes straight to
      // Gmail's Authorization header and is never logged or returned.
      async accessToken(fresh) {
        try {
          const stored = await getProviderToken(tenant.id, "google_mail");
          if (!fresh) return stored.token.access_token;
          const renewed = await getAdapter("google_mail").refresh(
            stored.token,
            stored.externalAccountId,
          );
          await vaultTokenStore().save(stored.connectionId, renewed);
          return renewed.access_token;
        } catch (err) {
          if (err instanceof ReconnectRequiredError) throw new SendRefused(RECONNECT);
          console.error("gmail sign-in failed", err instanceof Error ? err.message : "unknown");
          throw new SendRefused(
            "We couldn't reach Google to sign in. Nothing was sent; try again.",
          );
        }
      },

      send: (accessToken, raw, threadId) => sendGmail(accessToken, raw, threadId),

      async finish(args) {
        const { data, error } = await supabase.rpc("finish_po_email", {
          p_email_id: args.id,
          p_outcome: args.outcome,
          p_gmail_message_id: args.gmailMessageId ?? null,
          p_gmail_thread_id: args.gmailThreadId ?? null,
          p_error: args.error ?? null,
        });
        if (error) throw new Error(error.message);
        return { markedOrdered: data === true };
      },
    },
  );

  revalidatePath(`/w/${slug}/stock`, "layout");
  if (!result.ok) return { error: result.error };
  const who = [...result.to, ...result.cc.map((address) => `${address} (copy)`)].join(", ");
  return {
    sent: true,
    message: result.repeated
      ? `This one already went, from ${senderEmail}. It wasn't sent a second time.`
      : `Emailed to ${who} from ${senderEmail}${result.markedOrdered ? ", and the order is marked as ordered" : ""}.`,
  };
}

/** Saves the words every order email starts from. A config like any other. */
export async function saveOrderEmailTemplate(
  slug: string,
  _prev: EmailState,
  formData: FormData,
): Promise<EmailState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const parsed = poEmailSchema.safeParse({
    version: 1,
    subject: String(formData.get("subject") ?? ""),
    body: String(formData.get("body") ?? ""),
    cc_me: formData.get("cc_me") === "on",
    from_name: String(formData.get("from_name") ?? ""),
  });
  if (!parsed.success) {
    return {
      error:
        "Give it a subject (up to 200 characters) and a message (up to 4,000). The name can be up to 80.",
    };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: STOCK_MODULE,
    p_key: PO_EMAIL_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  revalidatePath(`/w/${slug}/stock`, "layout");
  return { message: "Saved." };
}
