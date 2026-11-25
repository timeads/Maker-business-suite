"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { formatMoney } from "@/lib/dashboard/format";
import { getEntitlements } from "@/lib/entitlements";
import { localDay } from "@/lib/bookings/slots";
import { inboundDomain } from "@/lib/helpdesk/addresses";
import { loadStockForBought, type BoughtLine } from "@/lib/stock/restock";
import {
  HELPDESK_MODULE,
  PRIORITIES,
  RULES_KEY,
  TAG_PATTERN,
  TEMPLATES_KEY,
  autoTagRulesSchema,
  parseRules,
  parseTemplates,
  replyTemplatesSchema,
  templateActionsSchema,
} from "@/lib/helpdesk/config";
import { sendPayloadSchema, summaryOf } from "@/lib/helpdesk/outbox";
import { draftReply } from "@/lib/helpdesk/draft";
import { loadDraftTopics } from "@/lib/helpdesk/manual/match";
import { readInsights } from "@/lib/helpdesk/insights";
import {
  FILES_BUCKET,
  displayName,
  filesNote,
  fromBase64,
  isKeptType,
  type IncomingFile,
} from "@/lib/helpdesk/files";
import { keepMessageFiles } from "@/lib/helpdesk/keep-files";
import {
  MAX_RECIPIENTS,
  fileSize,
  filesProblem,
  pickCarried,
  forwardedThread,
  outgoingText,
  parseRecipients,
  sendOutbound,
  type OutgoingFile,
} from "@/lib/helpdesk/outbound";
import { replyProblem } from "@/lib/helpdesk/reply";
import { isPlain, parseRichDoc, richToText, tidyDoc, type RichDoc } from "@/lib/helpdesk/rich";
import { SAVED_VIEWS_KEY, parseSavedViews, savedViewsSchema } from "@/lib/helpdesk/saved-views";
import { DESK_SETTINGS_KEY, deskSettingsSchema, parseDeskSettings } from "@/lib/helpdesk/settings";
import { isShelf } from "@/lib/helpdesk/views";
import { exportName, ticketsCsv, type ExportRow } from "@/lib/helpdesk/export";
import { TAG_GROUPS_KEY, parseTagGroups, tagGroupsSchema } from "@/lib/helpdesk/tag-groups";
import { postAlert } from "@/lib/messages/alerts";
import { handlesFor, nameOf, type Person } from "@/lib/messages/format";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type HelpdeskState = { error?: string; message?: string; draft?: string; id?: string };

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

/** For a prompt: which messages carried files, by name and kind only. Trouble reading them costs nothing. */
async function fileNotes(
  supabase: Ctx["supabase"],
  tenantId: string,
  messageIds: string[],
): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  if (messageIds.length === 0) return notes;
  const { data } = await supabase
    .from("message_attachments")
    .select("message_id, name, mime_type")
    .eq("tenant_id", tenantId)
    .in("message_id", messageIds);
  const by = new Map<string, { name: string; mime_type: string }[]>();
  for (const row of (data ?? []) as { message_id: string; name: string; mime_type: string }[]) {
    by.set(row.message_id, [...(by.get(row.message_id) ?? []), row]);
  }
  for (const [id, files] of by) notes.set(id, filesNote(files));
  return notes;
}

/** Asks Claude for a draft. It lands in the reply box; a person decides whether to send it. */
export async function draftTicketReply(
  slug: string,
  ticketId: string,
  _prev: HelpdeskState,
  formData?: FormData,
): Promise<HelpdeskState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_SECRET_KEY) {
    return { error: "Drafting isn't switched on for this environment yet." };
  }
  // What the teammate wants the draft to say. Their own words, never the customer's.
  const hint = String(formData?.get("hint") ?? "")
    .trim()
    .slice(0, 300);

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const [{ data: ticket }, { data: messages }, { data: templates }, { data: usage }] =
    await Promise.all([
      ctx.supabase
        .from("tickets")
        .select("id, subject, contacts(email, name, known_email)")
        .eq("id", ticketId)
        .eq("tenant_id", ctx.tenant.id)
        .maybeSingle(),
      ctx.supabase
        .from("messages")
        .select("id, direction, body, created_at")
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
    email: string | null;
    name: string | null;
    known_email: string | null;
  } | null;
  // Someone who messaged has orders to show only once the team wrote their email down.
  const orderEmail = contact?.email ?? contact?.known_email ?? null;
  const { data: orders } = orderEmail
    ? await ctx.supabase
        .from("orders")
        .select(
          "name, processed_at, total, currency, financial_status, fulfillment_status, order_lines(title, quantity, sku, variant_title, product_external_id)",
        )
        .eq("tenant_id", ctx.tenant.id)
        .eq("email", orderEmail)
        .order("processed_at", { ascending: false })
        .limit(5)
    : { data: [] };

  // What Stock says about the things they bought, read as this member. Left
  // out where the workspace has no Stock, or if it can't be read just now.
  let stock: string[] = [];
  if (ctx.entitlements.can("module.stock") && (orders ?? []).length > 0) {
    try {
      const bought = (orders ?? []).flatMap(
        (order) => (order.order_lines as BoughtLine[] | null) ?? [],
      );
      stock = (
        await loadStockForBought(
          ctx.supabase,
          ctx.tenant,
          bought,
          localDay(new Date(), ctx.tenant.timezone),
        )
      )
        .filter((item) => item.onHand <= 0 || item.incoming !== null)
        .slice(0, 12)
        .map((item) => `${item.name}: ${item.words}`);
    } catch {
      stock = [];
    }
  }

  const notes = await fileNotes(
    ctx.supabase,
    ctx.tenant.id,
    messages.map((m) => String(m.id)),
  );
  // What the team has written down about problems like this one, when the
  // workspace lets drafts lean on its manual. Found by words; no model asked.
  const manual = await loadDraftTopics(
    ctx.supabase,
    ctx.tenant.id,
    ticket.subject,
    messages.map((m) => ({ direction: String(m.direction), body: String(m.body) })),
  );
  try {
    const draft = await draftReply({
      hint,
      stock,
      manual,
      workspaceName: ctx.tenant.name,
      customerName: contact?.name ?? null,
      subject: ticket.subject,
      thread: messages.map((m) => ({
        from: m.direction === "inbound" ? ("customer" as const) : ("us" as const),
        body: String(m.body).slice(0, 6000) + (notes.get(String(m.id)) ?? ""),
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
  revalidatePath(`/w/${slug}/settings`, "layout");
  return { message: "Saved." };
}

export async function saveReplyTemplate(slug: string, _prev: HelpdeskState, formData: FormData) {
  return saveHelpdeskConfig(slug, TEMPLATES_KEY, (current) => {
    const existing = parseTemplates(current).templates;
    const name = String(formData.get("name") ?? "").trim();
    // What sending it also does: tags to add, what happens next, who gets it.
    const addTags = String(formData.get("add_tags") ?? "")
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);
    const then = String(formData.get("then") ?? "");
    const assign = String(formData.get("assign_to") ?? "");
    const actions = {
      ...(addTags.length > 0 ? { add_tags: addTags } : {}),
      ...(then ? { then } : {}),
      ...(assign ? { assign_to: assign } : {}),
    };
    const parsed = replyTemplatesSchema.safeParse({
      version: 1,
      templates: [
        ...existing,
        {
          id: `${slugify(name)}-${Date.now().toString(36)}`,
          name,
          body: String(formData.get("body") ?? ""),
          ...(Object.keys(actions).length > 0 ? { actions } : {}),
        },
      ],
    });
    return parsed.success
      ? { body: parsed.data }
      : {
          error:
            "A saved reply needs a name and some text (up to 4,000 characters). Tags are letters, numbers, spaces or dashes, five at most.",
        };
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
    const optional = (name: string) => String(formData.get(name) ?? "").trim() || undefined;
    if (!optional("tag") && !optional("priority") && !optional("assign_to")) {
      return {
        error:
          "Choose what the rule should do: add a tag, set how urgent it is, or hand it to someone.",
      };
    }
    const parsed = autoTagRulesSchema.safeParse({
      version: 1,
      rules: [
        ...existing,
        {
          id: `${slugify(contains)}-${Date.now().toString(36)}`,
          contains,
          where: formData.get("where") ?? "anywhere",
          tag: optional("tag"),
          priority: optional("priority"),
          assign_to: optional("assign_to"),
        },
      ],
    });
    return parsed.success
      ? { body: parsed.data }
      : {
          error:
            "A rule needs words to look for (at least two characters). Tags are letters, numbers, spaces or dashes.",
        };
  });
}

export async function deleteAutoTagRule(slug: string, _prev: HelpdeskState, formData: FormData) {
  return saveHelpdeskConfig(slug, RULES_KEY, (current) => {
    const id = formData.get("id");
    return { body: { version: 1, rules: parseRules(current).rules.filter((r) => r.id !== id) } };
  });
}

const done = (slug: string) => revalidatePath(`/w/${slug}/helpdesk`, "layout");
const TRY_AGAIN = "That didn't save. Try again in a moment.";

/** Hands a conversation to a teammate ("" for nobody). */
export async function assignTicket(slug: string, ticketId: string, userId: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) return;
  await ctx.supabase.rpc("assign_ticket", { p_ticket_id: ticketId, p_user_id: userId || null });
  done(slug);
}

export async function setTicketPriority(
  slug: string,
  ticketId: string,
  priority: string,
): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !(PRIORITIES as readonly string[]).includes(priority)) return;
  await ctx.supabase.rpc("set_ticket_priority", { p_ticket_id: ticketId, p_priority: priority });
  done(slug);
}

/** Puts a conversation aside until a time; null brings it back now. */
export async function snoozeTicket(
  slug: string,
  ticketId: string,
  until: string | null,
): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) return;
  await ctx.supabase.rpc("snooze_ticket", { p_ticket_id: ticketId, p_until: until });
  done(slug);
}

/** Leaves a note only the team sees. @names tell that person in Messages. */
export async function addTicketNote(
  slug: string,
  ticketId: string,
  _prev: HelpdeskState,
  formData: FormData,
): Promise<HelpdeskState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return { error: "Write a note first." };
  if (body.length > 4000) return { error: "Keep a note under 4,000 characters." };

  const [{ data: people }, { data: ticket }] = await Promise.all([
    ctx.supabase.rpc("chat_people", { p_tenant_id: ctx.tenant.id }),
    ctx.supabase
      .from("tickets")
      .select("number, subject")
      .eq("id", ticketId)
      .eq("tenant_id", ctx.tenant.id)
      .maybeSingle(),
  ]);
  if (!ticket) return { error: "That conversation couldn't be found." };
  const team = (people ?? []) as Person[];
  const words = new Set(
    (body.toLowerCase().match(/@[a-z0-9][a-z0-9._-]*/g) ?? []).map((w) =>
      w.slice(1).replace(/[._-]+$/, ""),
    ),
  );
  const mentioned = team.filter(
    (person) => person.user_id !== ctx.user.id && handlesFor(person).some((h) => words.has(h)),
  );
  const { error } = await ctx.supabase.rpc("add_ticket_note", {
    p_ticket_id: ticketId,
    p_body: body,
    p_mentions: mentioned.map((person) => person.user_id),
  });
  if (error) return { error: TRY_AGAIN };
  if (mentioned.length > 0 && process.env.SUPABASE_SECRET_KEY) {
    const me = nameOf(team.find((person) => person.user_id === ctx.user.id));
    await postAlert(
      getAdminClient(),
      ctx.tenant.id,
      "helpdesk",
      `${me} left a note for ${mentioned.map((p) => `@${handlesFor(p)[0]}`).join(" ")} on conversation #${ticket.number} (${ticket.subject}).`,
    );
  }
  done(slug);
  return { message: "Note added." };
}

/** Folds this conversation into another one, by its number. */
export async function mergeTicket(
  slug: string,
  ticketId: string,
  _prev: HelpdeskState,
  formData: FormData,
): Promise<HelpdeskState & { into?: number }> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const number = Number.parseInt(String(formData.get("into") ?? "").replace(/^#/, ""), 10);
  if (!(number > 0)) return { error: "Type the number of the conversation to join this into." };
  const { data: target } = await ctx.supabase
    .from("tickets")
    .select("id, merged_into")
    .eq("tenant_id", ctx.tenant.id)
    .eq("number", number)
    .maybeSingle();
  if (!target) return { error: `There's no conversation #${number}.` };
  if (target.id === ticketId) return { error: "That's this conversation. Pick a different one." };
  const { error } = await ctx.supabase.rpc("merge_tickets", {
    p_from_ticket_id: ticketId,
    p_into_ticket_id: target.id,
  });
  if (error) {
    return {
      error: error.message.includes("joined")
        ? "One of those has already been joined into another conversation."
        : TRY_AGAIN,
    };
  }
  done(slug);
  return { message: `Joined into #${number}.`, into: number };
}

// ---------------------------------------------------------------------------
// Mail going out: a reply, a reply with copies, a forward, or a new conversation
// ---------------------------------------------------------------------------

export type SendState = HelpdeskState & {
  sent?: boolean;
  number?: number;
  /** The email is waiting on the server and can still be taken back. */
  queued?: { id: string; seconds: number };
};

/** What a saved reply asked to happen as well, checked: tags to add and who gets the conversation. */
function readSendActions(
  formData: FormData,
  me: string,
): { tags: string[]; assignTo: string | null } {
  try {
    const parsed = templateActionsSchema.safeParse(
      JSON.parse(String(formData.get("macro_actions") ?? "{}")),
    );
    if (!parsed.success) return { tags: [], assignTo: null };
    return {
      tags: parsed.data.add_tags ?? [],
      assignTo: parsed.data.assign_to === "sender" ? me : (parsed.data.assign_to ?? null),
    };
  } catch {
    return { tags: [], assignTo: null };
  }
}

const THENS = ["pending", "open", "closed", "snoozed", "keep"] as const;

function readDoc(formData: FormData): RichDoc | null {
  try {
    const doc = parseRichDoc(JSON.parse(String(formData.get("doc") ?? "[]")));
    return doc ? tidyDoc(doc) : null;
  } catch {
    return null;
  }
}

async function readFiles(formData: FormData): Promise<OutgoingFile[] | { error: string }> {
  const picked = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const problem = filesProblem(picked.map((file) => ({ name: file.name, size: file.size })));
  if (problem) return { error: problem };
  return Promise.all(
    picked.map(async (file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      base64: Buffer.from(await file.arrayBuffer()).toString("base64"),
    })),
  );
}

type Ctx = Exclude<Awaited<ReturnType<typeof context>>, { error: string }>;

/** Sends one email from a conversation and writes down that it went. */
async function deliver(
  ctx: Ctx,
  ticketId: string,
  formData: FormData,
  kind: "reply" | "forward",
): Promise<SendState> {
  const doc = readDoc(formData);
  if (!doc) return { error: "That message couldn't be read. Try typing it again." };
  const words = richToText(doc);
  if (!words && kind === "reply") return { error: "Write a reply first." };
  if (words.length > 20_000) return { error: "That is too long to send as one email." };
  const to = parseRecipients(String(formData.get("to") ?? ""));
  const cc = parseRecipients(String(formData.get("cc") ?? ""));
  const bcc = parseRecipients(String(formData.get("bcc") ?? ""));
  const bad = [...to.bad, ...cc.bad, ...bcc.bad];
  if (bad.length > 0) return { error: `“${bad[0]}” isn't an email address.` };
  if (to.ok.length === 0) return { error: "Add who to send it to." };
  if (to.ok.length + cc.ok.length + bcc.ok.length > MAX_RECIPIENTS) {
    return { error: `An email can go to ${MAX_RECIPIENTS} addresses at most.` };
  }
  const asked = String(formData.get("then") ?? "");
  const then = THENS.find((one) => one === asked) ?? (kind === "forward" ? "keep" : "pending");
  const snooze = String(formData.get("snooze_until") ?? "");
  if (then === "snoozed" && !(Date.parse(snooze) > Date.now())) {
    return { error: "Pick when it should come back." };
  }
  const picked = await readFiles(formData);
  if ("error" in picked) return { error: picked.error };
  const domain = inboundDomain();
  if (!domain || !process.env.POSTMARK_SERVER_TOKEN || !process.env.SUPABASE_SECRET_KEY) {
    return { error: "Sending email isn't switched on for this environment yet." };
  }

  // Confirm the ticket is one this member can see before using elevated access.
  const { data: ticket } = await ctx.supabase
    .from("tickets")
    .select("id, number, merged_into")
    .eq("id", ticketId)
    .eq("tenant_id", ctx.tenant.id)
    .maybeSingle();
  if (!ticket) return { error: "That conversation couldn't be found." };
  if (ticket.merged_into) return { error: "This conversation was joined into another one." };

  // A forward takes the conversation's own kept files along. Which ones is
  // re-read here as this member (so only files they can see, on this ticket),
  // and each is fetched from the private bucket by the server.
  const files: OutgoingFile[] = [...picked];
  const notCarried: string[] = [];
  const carryIds = formData
    .getAll("carry")
    .map(String)
    .filter((id) => /^[0-9a-f-]{36}$/i.test(id))
    .slice(0, 20);
  if (kind === "forward" && carryIds.length > 0) {
    const { data: rows } = await ctx.supabase
      .from("message_attachments")
      .select("id, name, mime_type, bytes, storage_path, messages!inner(ticket_id)")
      .eq("tenant_id", ctx.tenant.id)
      .eq("state", "kept")
      .eq("messages.ticket_id", ticketId)
      .in("id", carryIds);
    const kept = (
      (rows ?? []) as unknown as {
        id: string;
        name: string;
        mime_type: string;
        bytes: number;
        storage_path: string | null;
      }[]
    )
      .filter(
        (row) => row.storage_path?.startsWith(`${ctx.tenant.id}/`) && isKeptType(row.mime_type),
      )
      .sort((a, b) => carryIds.indexOf(a.id) - carryIds.indexOf(b.id))
      .map((row) => ({ ...row, size: Number(row.bytes) }));
    const { carried, left } = pickCarried(
      kept,
      picked.reduce((sum, file) => sum + file.size, 0),
    );
    const bucket = getAdminClient().storage.from(FILES_BUCKET);
    for (const row of carried) {
      const { data: blob } = await bucket.download(row.storage_path!);
      if (!blob) {
        notCarried.push(row.name);
        continue;
      }
      files.push({
        name: displayName(row.name),
        type: row.mime_type,
        size: blob.size,
        base64: Buffer.from(await blob.arrayBuffer()).toString("base64"),
      });
    }
    notCarried.push(...left.map((row) => `${row.name} (${fileSize(row.size)})`));
  }

  let appendix: string | undefined;
  if (kind === "forward") {
    const { data: messages } = await ctx.supabase
      .from("messages")
      .select("direction, from_email, from_name, body, created_at")
      .eq("ticket_id", ticketId)
      .eq("tenant_id", ctx.tenant.id)
      .order("created_at", { ascending: true })
      .limit(40);
    const when = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: ctx.tenant.timezone,
    });
    appendix = forwardedThread(
      (messages ?? []).map((m) => ({
        from:
          m.direction === "outbound"
            ? ctx.tenant.name
            : m.from_name
              ? `${m.from_name} <${m.from_email}>`
              : String(m.from_email),
        at: when.format(new Date(String(m.created_at))),
        body: String(m.body),
      })),
    );
    if (notCarried.length > 0) {
      appendix += `\n\nNot attached (too big to forward together): ${notCarried.join(", ")}`;
    }
  }

  const extras = readSendActions(formData, ctx.user.id);
  const snoozeUntil = then === "snoozed" ? new Date(snooze).toISOString() : null;

  // With an undo wait set, the email isn't sent here at all: it is queued on
  // the server and the worker sends it when its time comes. Taking it back is
  // a request to the server too, so nothing depends on this tab staying open.
  const { data: deskConfig } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", HELPDESK_MODULE)
    .eq("key", DESK_SETTINGS_KEY)
    .maybeSingle();
  const undoSeconds = parseDeskSettings(deskConfig?.body).undo_seconds;
  if (undoSeconds > 0) {
    const payload = sendPayloadSchema.safeParse({
      kind,
      to: to.ok,
      cc: cc.ok,
      bcc: bcc.ok,
      doc,
      format: isPlain(doc) ? null : doc,
      appendix,
      then,
      snooze_until: snoozeUntil,
      files,
      add_tags: extras.tags,
      assign_to: extras.assignTo,
    });
    if (!payload.success) return { error: "That email couldn't be read. Try typing it again." };
    const { data: queuedId, error: queueError } = await ctx.supabase.rpc("queue_outbound", {
      p_ticket_id: ticketId,
      p_payload: payload.data,
      p_summary: summaryOf(payload.data),
      p_delay_seconds: undoSeconds,
    });
    if (queueError || !queuedId) {
      return {
        error: queueError?.message.includes("already waiting")
          ? "A few emails are already waiting to go on this conversation. Give them a moment."
          : "We couldn't send that. Nothing was sent; try again in a moment.",
      };
    }
    await ctx.supabase.rpc("mark_ticket_read", { p_ticket_id: ticketId });
    revalidatePath(`/w/${ctx.tenant.slug}/helpdesk`, "layout");
    return {
      sent: true,
      number: ticket.number as number,
      queued: { id: String(queuedId), seconds: undoSeconds },
    };
  }

  try {
    const { data: rows, error } = await getAdminClient().rpc("ticket_reply_context", {
      p_tenant_id: ctx.tenant.id,
      p_ticket_id: ticketId,
    });
    const info = (rows as Record<string, string | null>[] | null)?.[0];
    if (error || !info?.reply_key) throw new Error("no reply context");
    const providerId = await sendOutbound({
      kind,
      workspaceName: ctx.tenant.name,
      slug: ctx.tenant.slug,
      domain,
      replyKey: info.reply_key,
      to: to.ok,
      cc: cc.ok,
      bcc: bcc.ok,
      subject: info.subject ?? "",
      doc,
      appendix,
      inReplyTo: info.last_message_id,
      files,
    });
    const { data: messageId, error: recordError } = await ctx.supabase.rpc("record_outbound", {
      p_ticket_id: ticketId,
      p_body: outgoingText(doc, kind === "forward" ? undefined : appendix) || "(forwarded)",
      p_from_email: `support-${ctx.tenant.slug}@${domain}`,
      p_provider_message_id: providerId,
      p_kind: kind,
      p_to: to.ok,
      p_cc: cc.ok,
      p_format: isPlain(doc) ? null : doc,
      p_attachments: files.map((file) => ({ name: file.name.slice(0, 120), size: file.size })),
      p_then: then,
      p_snooze_until: snoozeUntil,
    });
    if (recordError) throw new Error(recordError.message);
    if (extras.tags.length > 0 || extras.assignTo) {
      await ctx.supabase.rpc("apply_send_actions", {
        p_ticket_id: ticketId,
        p_add_tags: extras.tags,
        p_assign_to: extras.assignTo,
      });
    }
    // Keep what was sent, so the conversation shows it. The email has gone
    // either way: trouble here never turns a sent email into a failure.
    if (messageId && files.length > 0) {
      try {
        await keepMessageFiles(
          getAdminClient(),
          { tenantId: ctx.tenant.id, ticketId, messageId: String(messageId) },
          files.map((file): IncomingFile => ({
            name: file.name,
            claimed: file.type,
            bytes: fromBase64(file.base64),
            contentId: null,
          })),
        );
      } catch (err) {
        console.error("Sent files weren't kept", err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("Send failed", err instanceof Error ? err.message : err);
    return { error: replyProblem(err) };
  }
  // Whoever sent it has read it.
  await ctx.supabase.rpc("mark_ticket_read", { p_ticket_id: ticketId });
  revalidatePath(`/w/${ctx.tenant.slug}/helpdesk`, "layout");
  return { sent: true, number: ticket.number as number };
}

/** A reply (with or without copies) or a forward, from the composer. */
export async function sendMail(
  slug: string,
  ticketId: string,
  formData: FormData,
): Promise<SendState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  return deliver(ctx, ticketId, formData, formData.get("mode") === "forward" ? "forward" : "reply");
}

/** Starts a conversation with a customer: a new ticket, then its first email. */
export async function startConversation(slug: string, formData: FormData): Promise<SendState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const to = parseRecipients(String(formData.get("to") ?? ""));
  if (to.bad.length > 0 || to.ok.length !== 1) {
    return { error: "Type one email address to write to." };
  }
  const subject = String(formData.get("subject") ?? "").trim();
  if (!subject) return { error: "Give it a subject." };
  const doc = readDoc(formData);
  if (!doc || !richToText(doc)) return { error: "Write the email first." };
  if (!inboundDomain() || !process.env.POSTMARK_SERVER_TOKEN || !process.env.SUPABASE_SECRET_KEY) {
    return { error: "Sending email isn't switched on for this environment yet." };
  }
  const { data, error } = await ctx.supabase.rpc("start_ticket", {
    p_tenant_id: ctx.tenant.id,
    p_email: to.ok[0],
    p_name: String(formData.get("name") ?? "").trim() || null,
    p_subject: subject,
  });
  const made = (data as { id: string; number: number }[] | null)?.[0];
  if (error || !made)
    return { error: "That conversation couldn't be started. Try again in a moment." };
  const sent = await deliver(ctx, made.id, formData, "reply");
  // The conversation exists either way; if the email didn't go it can be sent from there.
  return sent.error
    ? {
        error: `${sent.error} The conversation was started as #${made.number}; open it to try again.`,
        number: made.number,
      }
    : sent;
}

// ---------------------------------------------------------------------------
// The ticket's own fields
// ---------------------------------------------------------------------------

export async function setStatus(slug: string, ticketId: string, status: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !["open", "pending", "closed"].includes(status)) return;
  await ctx.supabase.rpc("set_ticket_status", { p_ticket_id: ticketId, p_status: status });
  done(slug);
}

export async function setTags(
  slug: string,
  ticketId: string,
  tags: string[],
): Promise<string | null> {
  const ctx = await context(slug);
  if ("error" in ctx) return ctx.error ?? null;
  const clean = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  const bad = clean.find((tag) => !TAG_PATTERN.test(tag));
  if (bad) return `“${bad}” can't be a tag. Use letters, numbers, spaces and dashes.`;
  if (clean.length > 10) return "Ten tags is the most a conversation can have.";
  const { error } = await ctx.supabase.rpc("set_ticket_tags", {
    p_ticket_id: ticketId,
    p_tags: clean,
  });
  if (error) return TRY_AGAIN;
  done(slug);
  return null;
}

/** Files a conversation in a folder ("" puts it back in the inbox). */
export async function fileTicket(slug: string, ticketId: string, folderId: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) return;
  await ctx.supabase.rpc("file_ticket", { p_ticket_id: ticketId, p_folder_id: folderId || null });
  done(slug);
}

export async function renameTicket(slug: string, ticketId: string, subject: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !subject.trim()) return;
  await ctx.supabase.rpc("set_ticket_subject", { p_ticket_id: ticketId, p_subject: subject });
  done(slug);
}

/** This person has seen the conversation (or wants it marked as not seen). */
export async function markRead(slug: string, ticketId: string, read: boolean): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) return;
  await ctx.supabase.rpc(read ? "mark_ticket_read" : "mark_ticket_unread", {
    p_ticket_id: ticketId,
  });
  done(slug);
}

/** "Summarize": a few lines for the team, kept on the ticket. Never sent anywhere. */
export async function summarizeTicket(slug: string, ticketId: string): Promise<HelpdeskState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_SECRET_KEY) {
    return { error: "Summaries aren't switched on for this environment yet." };
  }
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const [{ data: ticket }, { data: messages }, { data: usage }] = await Promise.all([
    ctx.supabase
      .from("tickets")
      .select("id, subject")
      .eq("id", ticketId)
      .eq("tenant_id", ctx.tenant.id)
      .maybeSingle(),
    ctx.supabase
      .from("messages")
      .select("id, direction, body, created_at")
      .eq("ticket_id", ticketId)
      .eq("tenant_id", ctx.tenant.id)
      .order("created_at", { ascending: true })
      .limit(30),
    ctx.supabase
      .from("usage_events")
      .select("quantity")
      .eq("tenant_id", ctx.tenant.id)
      .eq("type", "ai_tokens")
      .gte("occurred_at", monthStart.toISOString()),
  ]);
  if (!ticket || !messages?.length) return { error: "There is nothing to summarize yet." };
  const used = (usage ?? []).reduce((sum, row) => sum + Number(row.quantity), 0);
  if (used >= ctx.entitlements.limit("ai_credits")) {
    return {
      error:
        "You've used this month's AI allowance. It resets next month, or you can upgrade your plan for more.",
    };
  }
  const notes = await fileNotes(
    ctx.supabase,
    ctx.tenant.id,
    messages.map((m) => String(m.id)),
  );
  try {
    const result = await readInsights({
      subject: ticket.subject,
      thread: messages.map((m) => ({
        from: m.direction === "inbound" ? ("customer" as const) : ("us" as const),
        body: String(m.body).slice(0, 6000) + (notes.get(String(m.id)) ?? ""),
        at: String(m.created_at).slice(0, 10),
      })),
    });
    const { error: usageError } = await getAdminClient().rpc("record_usage", {
      p_tenant_id: ctx.tenant.id,
      p_type: "ai_tokens",
      p_quantity: result.tokens,
    });
    if (usageError) console.error(`Could not record AI usage: ${usageError.message}`);
    if (!result.ok) return { error: "Claude couldn't summarize this one." };
    const { error } = await ctx.supabase.rpc("set_ticket_insights", {
      p_ticket_id: ticketId,
      p_summary: result.insights.summary,
      p_mood: result.insights.mood,
      p_kind: result.insights.kind,
    });
    if (error) return { error: TRY_AGAIN };
  } catch (err) {
    console.error("Summary failed", err instanceof Error ? err.message : err);
    return { error: "We couldn't get a summary just now. Try again in a moment." };
  }
  done(slug);
  return { message: "Summarized." };
}

// ---------------------------------------------------------------------------
// Folders (owners and admins make them) and saved views (a config)
// ---------------------------------------------------------------------------

const folderProblem = (message: string) =>
  message.includes("owners and admins")
    ? "Only owners and admins can change folders."
    : message.includes("duplicate") || message.includes("ticket_folders_name_idx")
      ? "There is already a folder with that name."
      : message.includes("Forty")
        ? "Forty folders is the most a workspace can have."
        : TRY_AGAIN;

export async function saveFolder(slug: string, _prev: HelpdeskState, formData: FormData) {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 40) return { error: "A folder needs a name of up to 40 characters." };
  const id = String(formData.get("id") ?? "");
  const { data: made, error } = id
    ? await ctx.supabase.rpc("rename_ticket_folder", { p_folder_id: id, p_name: name })
    : await ctx.supabase.rpc("create_ticket_folder", { p_tenant_id: ctx.tenant.id, p_name: name });
  if (error) return { error: folderProblem(error.message) };
  done(slug);
  revalidatePath(`/w/${slug}/settings`, "layout");
  return id ? { message: "Renamed." } : { message: "Folder made.", id: String(made ?? "") };
}

export async function deleteFolder(slug: string, _prev: HelpdeskState, formData: FormData) {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("delete_ticket_folder", {
    p_folder_id: String(formData.get("id") ?? ""),
  });
  if (error) return { error: folderProblem(error.message) };
  done(slug);
  revalidatePath(`/w/${slug}/settings`, "layout");
  return { message: "Folder removed. What was in it is back in the inbox." };
}

/** Saves a view: a name and the filters it keeps. Owners and admins, like every config. */
export async function saveView(slug: string, _prev: HelpdeskState, formData: FormData) {
  return saveHelpdeskConfig(slug, SAVED_VIEWS_KEY, (current) => {
    const existing = parseSavedViews(current).views;
    const name = String(formData.get("name") ?? "").trim();
    const text = (key: string) => String(formData.get(key) ?? "").trim() || undefined;
    const tags = (text("tags") ?? "")
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);
    const priority = formData.getAll("priority").map(String).filter(Boolean);
    const parsed = savedViewsSchema.safeParse({
      version: 1,
      views: [
        ...existing,
        {
          id: `${slugify(name)}-${Date.now().toString(36)}`,
          name,
          conditions: {
            status: text("status") ?? "active",
            assignee: text("assignee"),
            tags_any: tags.length > 0 ? tags : undefined,
            folder: text("folder"),
            priority: priority.length > 0 ? priority : undefined,
            channel: text("channel"),
            text: text("text"),
            unread: formData.get("unread") ? true : undefined,
          },
        },
      ],
    });
    return parsed.success
      ? { body: parsed.data }
      : { error: "A view needs a name (up to 40 characters), and its filters have to make sense." };
  });
}

export async function deleteView(slug: string, _prev: HelpdeskState, formData: FormData) {
  return saveHelpdeskConfig(slug, SAVED_VIEWS_KEY, (current) => {
    const id = formData.get("id");
    return {
      body: { version: 1, views: parseSavedViews(current).views.filter((v) => v.id !== id) },
    };
  });
}

/** How the desk behaves: the business's own addresses, the undo wait, what follows a close. */
export async function saveDeskSettings(slug: string, _prev: HelpdeskState, formData: FormData) {
  return saveHelpdeskConfig(slug, DESK_SETTINGS_KEY, (current) => {
    const now = parseDeskSettings(current);
    const own = parseRecipients(String(formData.get("own_addresses") ?? ""));
    if (own.bad.length > 0) return { error: `“${own.bad[0]}” isn't an email address.` };
    const has = (key: string) => formData.get(key) !== null;
    const parsed = deskSettingsSchema.safeParse({
      ...now,
      own_addresses: has("own_addresses") ? own.ok : now.own_addresses,
      undo_seconds: has("undo_seconds") ? Number(formData.get("undo_seconds")) : now.undo_seconds,
      after_close: has("after_close") ? formData.get("after_close") : now.after_close,
      auto_open: has("auto_open_set") ? formData.get("auto_open") === "1" : now.auto_open,
    });
    return parsed.success
      ? { body: parsed.data }
      : { error: "Up to ten addresses, and choices from the lists." };
  });
}

// ---------------------------------------------------------------------------
// Archive, Spam and the Trash
// ---------------------------------------------------------------------------

/** Puts a conversation on a shelf ("archived", "spam", "trash"), or ("") takes it off and reopens it. */
export async function shelveTicket(slug: string, ticketId: string, shelf: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || (shelf !== "" && !isShelf(shelf))) return;
  await ctx.supabase.rpc("shelve_ticket", { p_ticket_id: ticketId, p_shelf: shelf || null });
  done(slug);
}

/** Removes one conversation from the Trash for good. Owners and admins; the database checks again. */
export async function deleteForGood(slug: string, ticketId: string): Promise<HelpdeskState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!canManage(ctx.role)) return { error: "Only owners and admins can delete for good." };
  const { error } = await ctx.supabase.rpc("delete_ticket_for_good", { p_ticket_id: ticketId });
  if (error) {
    return {
      error: error.message.includes("Trash first")
        ? "Move it to the Trash first."
        : "That couldn't be deleted. Try again in a moment.",
    };
  }
  done(slug);
  return { message: "Deleted for good." };
}

/** Empties the Trash: every conversation in it, with its emails, notes and files. */
export async function emptyTrash(slug: string): Promise<HelpdeskState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!canManage(ctx.role)) return { error: "Only owners and admins can empty the Trash." };
  const { data, error } = await ctx.supabase.rpc("empty_ticket_trash", {
    p_tenant_id: ctx.tenant.id,
  });
  if (error) return { error: "The Trash couldn't be emptied. Try again in a moment." };
  done(slug);
  return { message: `${Number(data ?? 0)} deleted for good.` };
}

// ---------------------------------------------------------------------------
// Email waiting to go, and empty conversations
// ---------------------------------------------------------------------------

/** Takes back an email that is still waiting. True when it will never go. */
export async function undoSend(slug: string, id: string): Promise<boolean> {
  const ctx = await context(slug);
  if ("error" in ctx || !/^[0-9a-f-]{36}$/i.test(id)) return false;
  const { data } = await ctx.supabase.rpc("cancel_outbound", { p_id: id });
  done(slug);
  return data === true;
}

/** Clears the notice about an email that didn't go. */
export async function dismissSend(slug: string, id: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !/^[0-9a-f-]{36}$/i.test(id)) return;
  await ctx.supabase.rpc("dismiss_outbound", { p_id: id });
  done(slug);
}

/** Throws away a conversation that was started and never written. */
export async function discardEmptyTicket(slug: string, ticketId: string): Promise<HelpdeskState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("discard_empty_ticket", { p_ticket_id: ticketId });
  if (error) {
    return {
      error: error.message.includes("empty conversation")
        ? "Something has been said on this one, so it can't be removed this way. Use Delete under the ⋯ menu."
        : TRY_AGAIN,
    };
  }
  done(slug);
  return { message: "Removed." };
}

// ---------------------------------------------------------------------------
// Several conversations at once, and the list as a spreadsheet
// ---------------------------------------------------------------------------

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BulkChange =
  | { status: "open" | "pending" | "closed" }
  | { snooze_until: string }
  | { assignee: string | null }
  | { folder: string | null }
  | { shelf: "archived" | "spam" | "trash" | null }
  | { add_tags: string[] }
  | { remove_tags: string[] };

/**
 * One change to every ticked conversation, in one request. The browser only
 * names them: the database checks each is this workspace's, that the person
 * is on its team, and that the teammate or folder named belongs to it too.
 */
export async function bulkUpdate(
  slug: string,
  ids: string[],
  change: BulkChange,
): Promise<HelpdeskState & { count?: number }> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const clean = [...new Set(ids.filter((id) => ID.test(id)))];
  if (clean.length === 0) return { error: "Tick at least one conversation." };
  if (clean.length > 200) return { error: "200 at a time is the most. Untick a few." };
  const safe: Record<string, unknown> = {};
  if ("status" in change && ["open", "pending", "closed"].includes(change.status)) {
    safe.status = change.status;
  } else if ("snooze_until" in change && Date.parse(change.snooze_until) > Date.now()) {
    safe.snooze_until = new Date(change.snooze_until).toISOString();
  } else if ("assignee" in change && (change.assignee === null || ID.test(change.assignee))) {
    safe.assignee = change.assignee;
  } else if ("folder" in change && (change.folder === null || ID.test(change.folder))) {
    safe.folder = change.folder;
  } else if ("shelf" in change && (change.shelf === null || isShelf(change.shelf))) {
    safe.shelf = change.shelf;
  } else if ("add_tags" in change || "remove_tags" in change) {
    const key = "add_tags" in change ? "add_tags" : "remove_tags";
    const tags = ("add_tags" in change ? change.add_tags : change.remove_tags)
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 10);
    const bad = tags.find((tag) => !TAG_PATTERN.test(tag));
    if (bad) return { error: `“${bad}” can't be a tag. Use letters, numbers, spaces and dashes.` };
    if (tags.length === 0) return { error: "Type a tag first." };
    safe[key] = tags;
  }
  if (Object.keys(safe).length === 0) return { error: "That change couldn't be read." };
  const { data, error } = await ctx.supabase.rpc("bulk_update_tickets", {
    p_tenant_id: ctx.tenant.id,
    p_ticket_ids: clean,
    p_change: safe,
  });
  if (error) {
    return {
      error: error.message.includes("coming year") ? "Pick a time in the coming year." : TRY_AGAIN,
    };
  }
  done(slug);
  return { count: Number(data ?? 0) };
}

/**
 * The conversations named, as a spreadsheet: who, what about, where it stands
 * and when. No message text. Owners and admins only; each row is read as this
 * person, so only what they can see comes out.
 */
export async function exportTickets(
  slug: string,
  ids: string[],
): Promise<{ error?: string; csv?: string; name?: string }> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!canManage(ctx.role)) return { error: "Only owners and admins can export conversations." };
  const clean = [...new Set(ids.filter((id) => ID.test(id)))].slice(0, 2000);
  if (clean.length === 0) return { error: "There is nothing in this list to export." };
  const { data: people } = await ctx.supabase.rpc("chat_people", { p_tenant_id: ctx.tenant.id });
  const team = (people ?? []) as Person[];
  const rows: ExportRow[] = [];
  for (let at = 0; at < clean.length; at += 200) {
    const chunk = clean.slice(at, at + 200);
    const [{ data: tickets, error }, { data: facts }] = await Promise.all([
      ctx.supabase
        .from("tickets")
        .select(
          "id, number, subject, status, shelf, priority, assignee_id, created_at, last_message_at, first_reply_at, closed_at, ai_kind, ai_mood, contacts(email, name), ticket_tags(tags(name))",
        )
        .eq("tenant_id", ctx.tenant.id)
        .in("id", chunk),
      ctx.supabase.rpc("ticket_list_facts", { p_ticket_ids: chunk }),
    ]);
    if (error) return { error: "The export couldn't be made. Try again in a moment." };
    const counts = new Map(
      ((facts ?? []) as { ticket_id: string; message_count: number }[]).map((f) => [
        f.ticket_id,
        f.message_count,
      ]),
    );
    for (const t of (tickets ?? []) as unknown as Record<string, unknown>[]) {
      const contact = (Array.isArray(t.contacts) ? t.contacts[0] : t.contacts) as {
        email: string;
        name: string | null;
      } | null;
      const owner = team.find((person) => person.user_id === t.assignee_id);
      rows.push({
        number: Number(t.number),
        subject: String(t.subject),
        customer_name: contact?.name ?? null,
        customer_email: contact?.email ?? null,
        status: String(t.shelf ?? (t.status === "pending" ? "in progress" : t.status)),
        priority: String(t.priority),
        assignee: owner ? nameOf(owner) : null,
        tags: ((t.ticket_tags as { tags: { name: string } | { name: string }[] | null }[]) ?? [])
          .map((tt) => (Array.isArray(tt.tags) ? tt.tags[0]?.name : tt.tags?.name))
          .filter((name): name is string => Boolean(name)),
        messages: counts.get(String(t.id)) ?? 0,
        created_at: String(t.created_at),
        last_message_at: String(t.last_message_at),
        first_reply_at: (t.first_reply_at as string | null) ?? null,
        closed_at: (t.closed_at as string | null) ?? null,
        kind: (t.ai_kind as string | null) ?? null,
        mood: (t.ai_mood as string | null) ?? null,
      });
    }
  }
  // Newest first, as the owner's help desk exports them.
  rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return {
    csv: ticketsCsv(rows),
    name: exportName(localDay(new Date(), ctx.tenant.timezone)),
  };
}

// ---------------------------------------------------------------------------
// Tags in groups (a config)
// ---------------------------------------------------------------------------

export async function saveTagGroup(slug: string, _prev: HelpdeskState, formData: FormData) {
  return saveHelpdeskConfig(slug, TAG_GROUPS_KEY, (current) => {
    const existing = parseTagGroups(current).groups;
    const name = String(formData.get("name") ?? "").trim();
    const tags = [
      ...new Set(
        String(formData.get("tags") ?? "")
          .split(",")
          .map((tag) => tag.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    const parsed = tagGroupsSchema.safeParse({
      version: 1,
      groups: [...existing, { id: `${slugify(name)}-${Date.now().toString(36)}`, name, tags }],
    });
    return parsed.success
      ? { body: parsed.data }
      : {
          error:
            "A group needs a name and at least one tag. Tags are letters, numbers, spaces or dashes.",
        };
  });
}

export async function deleteTagGroup(slug: string, _prev: HelpdeskState, formData: FormData) {
  return saveHelpdeskConfig(slug, TAG_GROUPS_KEY, (current) => {
    const id = formData.get("id");
    return {
      body: { version: 1, groups: parseTagGroups(current).groups.filter((g) => g.id !== id) },
    };
  });
}
