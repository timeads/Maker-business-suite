"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { formatMoney } from "@/lib/dashboard/format";
import { getEntitlements } from "@/lib/entitlements";
import { inboundDomain } from "@/lib/helpdesk/addresses";
import {
  HELPDESK_MODULE,
  RULES_KEY,
  TAG_PATTERN,
  TEMPLATES_KEY,
  autoTagRulesSchema,
  parseRules,
  parseTemplates,
  replyTemplatesSchema,
} from "@/lib/helpdesk/config";
import { draftReply } from "@/lib/helpdesk/draft";
import { sendReply } from "@/lib/helpdesk/reply";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type HelpdeskState = { error?: string; message?: string; draft?: string };

const NO_ACCESS = "The help desk isn't part of this workspace's plan right now.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/helpdesk`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.helpdesk")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  return {
    user,
    tenant: ctx.tenant,
    role: ctx.role,
    entitlements,
    supabase: await createClient(),
  } as const;
}

/** Sends a teammate's reply to the customer and records it on the ticket. */
export async function sendTicketReply(
  slug: string,
  ticketId: string,
  _prev: HelpdeskState,
  formData: FormData,
): Promise<HelpdeskState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return { error: "Write a reply first." };
  if (body.length > 20_000) return { error: "That reply is too long to send as one email." };
  const domain = inboundDomain();
  if (!domain || !process.env.POSTMARK_SERVER_TOKEN || !process.env.SUPABASE_SECRET_KEY) {
    return { error: "Sending email isn't switched on for this environment yet." };
  }

  // Confirm the ticket is one this member can see before using elevated access.
  const { data: ticket } = await ctx.supabase
    .from("tickets")
    .select("id, number")
    .eq("id", ticketId)
    .eq("tenant_id", ctx.tenant.id)
    .maybeSingle();
  if (!ticket) return { error: "That conversation couldn't be found." };

  try {
    const { data: rows, error } = await getAdminClient().rpc("ticket_reply_context", {
      p_tenant_id: ctx.tenant.id,
      p_ticket_id: ticketId,
    });
    const info = (rows as Record<string, string | null>[] | null)?.[0];
    if (error || !info?.reply_key || !info.contact_email) throw new Error("no reply context");

    const providerId = await sendReply({
      workspaceName: ctx.tenant.name,
      slug: ctx.tenant.slug,
      domain,
      replyKey: info.reply_key,
      to: info.contact_email,
      subject: info.subject ?? "",
      body,
      inReplyTo: info.last_message_id,
    });
    const { error: recordError } = await ctx.supabase.rpc("record_reply", {
      p_ticket_id: ticketId,
      p_body: body,
      p_from_email: `support-${ctx.tenant.slug}@${domain}`,
      p_provider_message_id: providerId,
    });
    if (recordError) throw new Error(recordError.message);
  } catch (err) {
    console.error("Reply failed", err instanceof Error ? err.message : err);
    return { error: "We couldn't send that reply. Nothing was sent; try again in a moment." };
  }
  revalidatePath(`/w/${slug}/helpdesk`, "layout");
  return { message: "Reply sent." };
}

/** Asks Claude for a draft. It lands in the reply box; a person decides whether to send it. */
export async function draftTicketReply(
  slug: string,
  ticketId: string,
  _prev: HelpdeskState,
): Promise<HelpdeskState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_SECRET_KEY) {
    return { error: "Drafting isn't switched on for this environment yet." };
  }

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const [{ data: ticket }, { data: messages }, { data: templates }, { data: usage }] =
    await Promise.all([
      ctx.supabase
        .from("tickets")
        .select("id, subject, contacts(email, name)")
        .eq("id", ticketId)
        .eq("tenant_id", ctx.tenant.id)
        .maybeSingle(),
      ctx.supabase
        .from("messages")
        .select("direction, body, created_at")
        .eq("ticket_id", ticketId)
        .eq("tenant_id", ctx.tenant.id)
        .order("created_at", { ascending: true })
        .limit(30),
      ctx.supabase
        .from("configs")
        .select("body")
        .eq("tenant_id", ctx.tenant.id)
        .eq("module", HELPDESK_MODULE)
        .eq("key", TEMPLATES_KEY)
        .maybeSingle(),
      ctx.supabase
        .from("usage_events")
        .select("quantity")
        .eq("tenant_id", ctx.tenant.id)
        .eq("type", "ai_tokens")
        .gte("occurred_at", monthStart.toISOString()),
    ]);
  if (!ticket || !messages?.length) return { error: "That conversation couldn't be found." };

  const used = (usage ?? []).reduce((sum, row) => sum + Number(row.quantity), 0);
  if (used >= ctx.entitlements.limit("ai_credits")) {
    return {
      error:
        "You've used this month's AI allowance. It resets next month, or you can upgrade your plan for more.",
    };
  }

  const contact = (Array.isArray(ticket.contacts) ? ticket.contacts[0] : ticket.contacts) as {
    email: string;
    name: string | null;
  } | null;
  const { data: orders } = contact
    ? await ctx.supabase
        .from("orders")
        .select(
          "name, processed_at, total, currency, financial_status, fulfillment_status, order_lines(title, quantity)",
        )
        .eq("tenant_id", ctx.tenant.id)
        .eq("email", contact.email)
        .order("processed_at", { ascending: false })
        .limit(5)
    : { data: [] };

  try {
    const draft = await draftReply({
      workspaceName: ctx.tenant.name,
      customerName: contact?.name ?? null,
      subject: ticket.subject,
      thread: messages.map((m) => ({
        from: m.direction === "inbound" ? ("customer" as const) : ("us" as const),
        body: String(m.body).slice(0, 6000),
        at: String(m.created_at).slice(0, 10),
      })),
      templates: parseTemplates(templates?.body).templates.map((t) => ({
        name: t.name,
        body: t.body,
      })),
      orders: (orders ?? []).map((o) => ({
        name: o.name,
        date: String(o.processed_at).slice(0, 10),
        total: formatMoney(Number(o.total), o.currency ?? ctx.tenant.currency),
        payment: o.financial_status,
        fulfillment: o.fulfillment_status,
        items: ((o.order_lines as { title: string; quantity: number }[] | null) ?? []).map(
          (line) => `${line.quantity} × ${line.title}`,
        ),
      })),
    });

    // Metered whether or not a draft came back: the tokens were spent.
    const { error: usageError } = await getAdminClient().rpc("record_usage", {
      p_tenant_id: ctx.tenant.id,
      p_type: "ai_tokens",
      p_quantity: draft.tokens,
    });
    if (usageError) console.error(`Could not record AI usage: ${usageError.message}`);

    if (!draft.ok) {
      return {
        error: "Claude couldn't draft a reply for this one. You can write it yourself below.",
      };
    }
    return { draft: draft.text };
  } catch (err) {
    console.error("Draft failed", err instanceof Error ? err.message : err);
    return { error: "We couldn't get a draft just now. Try again in a moment." };
  }
}

export async function setTicketStatus(
  slug: string,
  ticketId: string,
  formData: FormData,
): Promise<void> {
  const ctx = await context(slug);
  const status = formData.get("status");
  if ("error" in ctx || !["open", "pending", "closed"].includes(String(status))) return;
  await ctx.supabase.rpc("set_ticket_status", { p_ticket_id: ticketId, p_status: status });
  revalidatePath(`/w/${slug}/helpdesk`, "layout");
}

export async function setTicketTags(
  slug: string,
  ticketId: string,
  _prev: HelpdeskState,
  formData: FormData,
): Promise<HelpdeskState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const tags = String(formData.get("tags") ?? "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  const bad = tags.find((tag) => !TAG_PATTERN.test(tag));
  if (bad) return { error: `"${bad}" can't be a tag. Use letters, numbers, spaces and dashes.` };
  if (tags.length > 10) return { error: "Ten tags is the most a conversation can have." };
  const { error } = await ctx.supabase.rpc("set_ticket_tags", {
    p_ticket_id: ticketId,
    p_tags: tags,
  });
  if (error) return { error: "We couldn't save those tags. Try again in a moment." };
  revalidatePath(`/w/${slug}/helpdesk`, "layout");
  return { message: "Tags saved." };
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "item";

async function saveHelpdeskConfig(
  slug: string,
  key: string,
  change: (current: unknown) => { body: object } | { error: string },
): Promise<HelpdeskState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!canManage(ctx.role))
    return { error: "Only owners and admins can change help desk settings." };
  const { data } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", HELPDESK_MODULE)
    .eq("key", key)
    .maybeSingle();
  const next = change(data?.body);
  if ("error" in next) return { error: next.error };
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: HELPDESK_MODULE,
    p_key: key,
    p_body: next.body,
  });
  if (error) return { error: "We couldn't save that. Try again in a moment." };
  revalidatePath(`/w/${slug}/helpdesk`, "layout");
  return { message: "Saved." };
}

export async function saveReplyTemplate(slug: string, _prev: HelpdeskState, formData: FormData) {
  return saveHelpdeskConfig(slug, TEMPLATES_KEY, (current) => {
    const existing = parseTemplates(current).templates;
    const name = String(formData.get("name") ?? "").trim();
    const parsed = replyTemplatesSchema.safeParse({
      version: 1,
      templates: [
        ...existing,
        {
          id: `${slugify(name)}-${Date.now().toString(36)}`,
          name,
          body: String(formData.get("body") ?? ""),
        },
      ],
    });
    return parsed.success
      ? { body: parsed.data }
      : { error: "A saved reply needs a name and some text (up to 4,000 characters)." };
  });
}

export async function deleteReplyTemplate(slug: string, _prev: HelpdeskState, formData: FormData) {
  return saveHelpdeskConfig(slug, TEMPLATES_KEY, (current) => {
    const id = formData.get("id");
    return {
      body: { version: 1, templates: parseTemplates(current).templates.filter((t) => t.id !== id) },
    };
  });
}

export async function saveAutoTagRule(slug: string, _prev: HelpdeskState, formData: FormData) {
  return saveHelpdeskConfig(slug, RULES_KEY, (current) => {
    const existing = parseRules(current).rules;
    const contains = String(formData.get("contains") ?? "").trim();
    const parsed = autoTagRulesSchema.safeParse({
      version: 1,
      rules: [
        ...existing,
        {
          id: `${slugify(contains)}-${Date.now().toString(36)}`,
          contains,
          where: formData.get("where") ?? "anywhere",
          tag: String(formData.get("tag") ?? ""),
        },
      ],
    });
    return parsed.success
      ? { body: parsed.data }
      : {
          error:
            "A rule needs words to look for (at least two characters) and a tag made of letters, numbers, spaces or dashes.",
        };
  });
}

export async function deleteAutoTagRule(slug: string, _prev: HelpdeskState, formData: FormData) {
  return saveHelpdeskConfig(slug, RULES_KEY, (current) => {
    const id = formData.get("id");
    return { body: { version: 1, rules: parseRules(current).rules.filter((r) => r.id !== id) } };
  });
}
