import { createHash } from "node:crypto";
import { z } from "zod";
import { Money } from "../balance/money";

/**
 * Emailing a purchase order to the supplier from the business's own Gmail
 * (ported from TuftStock's src/lib/po/email.ts). Pure, and tested:
 *  - what the order said when it was sent (`poSnapshot`) and a short
 *    fingerprint of it, so the page can tell "changed since you emailed it"
 *    and offer to send the changed order;
 *  - what changed between two sends (`poChanges`), for the resend's message;
 *  - the To, Subject and message a send starts from (`composeDefaults`),
 *    from the workspace's own template.
 */

// ---------------------------------------------------------------------------
// The workspace's template: a config like any other (module "stock").
// ---------------------------------------------------------------------------

export const PO_EMAIL_KEY = "po_email";

export const DEFAULT_SUBJECT = "{{month}} order – {{po_reference}}";
export const DEFAULT_BODY =
  "Hi {{contact_name}},\n\nPlease find attached purchase order {{po_reference}}. Let me know if you have any questions.\n\nThanks,\n{{sender_name}}";

/** The words a template can use, each swapped for the order's own. */
export const PO_EMAIL_PLACEHOLDERS = [
  "po_reference",
  "supplier_name",
  "contact_name",
  "month",
  "sender_name",
] as const;

export const poEmailSchema = z.object({
  version: z.literal(1),
  /** May use {{po_reference}}, {{supplier_name}}, {{contact_name}}, {{month}}, {{sender_name}}. */
  subject: z.string().trim().min(1).max(200).default(DEFAULT_SUBJECT),
  body: z.string().trim().min(1).max(4000).default(DEFAULT_BODY),
  /** Tick "send me a copy" to start with. */
  cc_me: z.boolean().default(false),
  /** The name suppliers see the email from; empty uses the workspace's name. */
  from_name: z.string().trim().max(80).default(""),
});
export type PoEmailTemplate = z.infer<typeof poEmailSchema>;
export const DEFAULT_PO_EMAIL: PoEmailTemplate = poEmailSchema.parse({ version: 1 });

export function parsePoEmail(body: unknown): PoEmailTemplate {
  const parsed = poEmailSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_PO_EMAIL;
}

// ---------------------------------------------------------------------------
// What the order said
// ---------------------------------------------------------------------------

export interface PoSnapshot {
  reference: string;
  lines: { key: string; title: string; sku: string | null; qty: number; unitCost: string }[];
  shipping: string;
  taxRatePct: string;
  adjustments: { label: string; amount: string }[];
  notes: string;
  expectedOn: string | null; // YYYY-MM-DD
}

/** An order as the email needs it. Lines taken off (quantity zero) are left out by the caller. */
export interface PoForEmail {
  reference: string;
  supplierName: string;
  contactName: string | null;
  lines: {
    stockItemId: string;
    title: string;
    sku: string | null;
    supplierSku: string | null;
    qtyOrdered: number;
    unitCost: string | number;
  }[];
  shippingCost: string | number;
  taxRatePct: string | number;
  adjustments: { label: string; amount: string }[];
  notes: string | null;
  expectedOn: string | null;
}

const cents = (value: string | number) => new Money(Number(value || 0).toFixed(2)).toFixed(2);
/** "8.8750" and "8.875" are the same rate. */
const rate = (value: string | number) => String(Number(value || 0));

/** The parts of the order that are on the PDF the supplier gets (not its status or what has arrived). */
export function poSnapshot(po: PoForEmail): PoSnapshot {
  return {
    reference: po.reference,
    lines: po.lines
      .filter((line) => line.qtyOrdered > 0)
      .map((line) => ({
        key: line.stockItemId,
        title: line.title,
        sku: line.sku ?? line.supplierSku ?? null,
        qty: line.qtyOrdered,
        unitCost: cents(line.unitCost),
      })),
    shipping: cents(po.shippingCost),
    taxRatePct: rate(po.taxRatePct),
    adjustments: po.adjustments.map((a) => ({ label: a.label, amount: cents(a.amount) })),
    notes: (po.notes ?? "").trim(),
    expectedOn: po.expectedOn ? po.expectedOn.slice(0, 10) : null,
  };
}

export function fingerprint(s: PoSnapshot): string {
  return createHash("sha256").update(JSON.stringify(s)).digest("hex").slice(0, 16);
}

/** A stored snapshot, read back. Null when it isn't one we wrote. */
export function readSnapshot(value: unknown): PoSnapshot | null {
  const s = value as Partial<PoSnapshot> | null;
  if (!s || typeof s !== "object" || typeof s.reference !== "string" || !Array.isArray(s.lines)) {
    return null;
  }
  return {
    reference: s.reference,
    lines: s.lines.map((line) => ({
      key: String(line?.key ?? ""),
      title: String(line?.title ?? ""),
      sku: line?.sku == null ? null : String(line.sku),
      qty: Number(line?.qty ?? 0),
      unitCost: String(line?.unitCost ?? "0.00"),
    })),
    shipping: String(s.shipping ?? "0.00"),
    taxRatePct: String(s.taxRatePct ?? "0"),
    adjustments: Array.isArray(s.adjustments)
      ? s.adjustments.map((a) => ({
          label: String(a?.label ?? ""),
          amount: String(a?.amount ?? "0.00"),
        }))
      : [],
    notes: String(s.notes ?? ""),
    expectedOn: typeof s.expectedOn === "string" ? s.expectedOn : null,
  };
}

const money = (value: string) => {
  const [whole, fraction] = new Money(value).toFixed(2).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
};
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (iso: string) => `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/** A plain-words list of what changed on the order since it was last sent. */
export function poChanges(before: PoSnapshot, after: PoSnapshot): string[] {
  const out: string[] = [];
  if (before.reference !== after.reference) {
    out.push(`PO number is now ${after.reference} (was ${before.reference})`);
  }

  const name = (l: PoSnapshot["lines"][number]) => (l.sku ? `${l.title} (${l.sku})` : l.title);
  const old = new Map(before.lines.map((l) => [l.key, l]));
  const seen = new Set<string>();
  for (const l of after.lines) {
    const was = old.get(l.key);
    seen.add(l.key);
    if (!was) {
      out.push(`Added ${name(l)} × ${l.qty}`);
      continue;
    }
    if (was.qty !== l.qty) out.push(`${name(l)}: ${was.qty} → ${l.qty}`);
    if (was.unitCost !== l.unitCost) {
      out.push(`${name(l)}: unit price ${money(was.unitCost)} → ${money(l.unitCost)}`);
    }
  }
  for (const l of before.lines) if (!seen.has(l.key)) out.push(`Removed ${name(l)}`);

  if (before.shipping !== after.shipping) {
    out.push(`Shipping ${money(before.shipping)} → ${money(after.shipping)}`);
  }
  if (before.taxRatePct !== after.taxRatePct) {
    out.push(`Tax ${before.taxRatePct}% → ${after.taxRatePct}%`);
  }
  if (JSON.stringify(before.adjustments) !== JSON.stringify(after.adjustments)) {
    out.push("Adjustments updated");
  }
  if (before.expectedOn !== after.expectedOn) {
    out.push(
      after.expectedOn
        ? `Expected delivery ${shortDay(after.expectedOn)}`
        : "Expected delivery date removed",
    );
  }
  if (before.notes !== after.notes) out.push("Notes updated");
  return out;
}

// ---------------------------------------------------------------------------
// What a send starts from
// ---------------------------------------------------------------------------

export interface LastSend {
  subject: string;
  sentAt: string; // ISO
  snapshot: PoSnapshot | null;
}

export interface ComposeInput {
  po: PoForEmail;
  /** The supplier's saved addresses, main one first. */
  contactEmails: string[];
  templates: { subject?: string | null; body?: string | null };
  /** First name to sign with ("Dana"). */
  senderName: string;
  last: LastSend | null;
  now: Date;
  /** The workspace's own timezone: which month it is, and the day an earlier send went. */
  timezone: string;
}

export interface ComposeDefaults {
  to: string;
  subject: string;
  body: string;
  isResend: boolean;
  changes: string[];
}

export function composeDefaults(c: ComposeInput): ComposeDefaults {
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: c.timezone }).format(
    c.now,
  );
  const contact = c.po.contactName?.trim() || "there";
  const vars: Record<string, string> = {
    po_reference: c.po.reference,
    supplier_name: c.po.supplierName,
    contact_name: contact,
    month,
    sender_name: c.senderName,
  };
  const fill = (t: string) => t.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);
  const to = c.contactEmails.join(", ");

  if (!c.last) {
    return {
      to,
      subject: fill(c.templates.subject?.trim() || DEFAULT_SUBJECT),
      body: fill(c.templates.body?.trim() || DEFAULT_BODY),
      isResend: false,
      changes: [],
    };
  }

  const changes = c.last.snapshot ? poChanges(c.last.snapshot, poSnapshot(c.po)) : [];
  const sentOn = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: c.timezone,
  }).format(new Date(c.last.sentAt));
  const intro =
    changes.length > 0 || !c.last.snapshot
      ? `I've updated purchase order ${c.po.reference}. The new version is attached and replaces the one I sent on ${sentOn}.`
      : `Here's purchase order ${c.po.reference} again (same as the one I sent on ${sentOn}).`;
  const what =
    changes.length > 0 ? `\n\nWhat changed:\n${changes.map((x) => `- ${x}`).join("\n")}` : "";
  return {
    to,
    subject: /^re:/i.test(c.last.subject) ? c.last.subject : `Re: ${c.last.subject}`,
    body: `Hi ${contact},\n\n${intro}${what}\n\nThanks,\n${c.senderName}`,
    isResend: true,
    changes,
  };
}

/** "Dana Reyes" → "Dana"; falls back to the address's name part. */
export function firstName(name: string | null | undefined, email: string): string {
  const n = name?.trim().split(/\s+/)[0];
  if (n) return n;
  const local = email.split("@")[0] ?? "";
  return local ? local[0]!.toUpperCase() + local.slice(1) : "";
}

/** The button's words, as TuftStock has them. */
export function sendLabel(input: {
  isDraft: boolean;
  isResend: boolean;
  changed: boolean;
}): string {
  if (input.isDraft) return "Send & mark ordered";
  if (!input.isResend) return "Send";
  return input.changed ? "Send the changed order" : "Send again";
}
