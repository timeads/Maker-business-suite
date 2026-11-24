import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SHIPPING_MODULE,
  SHIPPING_SETTINGS_KEY,
  parseShippingSettings,
  shipFromCityLine,
} from "@/lib/shipping/config";
import { pickLogoAsset } from "@/lib/social/photo-match";
import { publicAssetUrl } from "@/lib/social/worker";
import type { PoDocumentInput } from "@/lib/stock/po/document";
import type { PoForEmail } from "@/lib/stock/po/email";
import type { PoLogo } from "@/lib/stock/po/pdf";
import { parseAdjustments } from "@/lib/stock/po/totals";

/**
 * One purchase order, read once for the two things that show it to a
 * supplier: the PDF, and the email that carries the PDF. Read as the signed-in
 * member, so row-level security decides what there is to see.
 */

const LOGO_TYPES: Record<string, PoLogo["format"]> = { "image/png": "png", "image/jpeg": "jpg" };
const LOGO_MAX_BYTES = 2_000_000;

/** A reference as a file name: nothing a header or a disk would trip on. */
export const poFileName = (reference: string) =>
  `${reference.replace(/[^A-Za-z0-9._-]+/g, "-") || "purchase-order"}.pdf`;

/**
 * The workspace's own logo: the picture tagged `logo` in its Assets, read
 * from our own storage (never an address a person typed). Only a PNG or JPEG
 * can go on a PDF; anything else, or any trouble, and the order goes without.
 */
export async function loadPoLogo(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<PoLogo | null> {
  try {
    const { data } = await supabase
      .from("social_assets")
      .select("id, storage_path, title, tags, mime_type")
      .eq("tenant_id", tenantId)
      .eq("hidden", false)
      .in("mime_type", Object.keys(LOGO_TYPES))
      .order("created_at", { ascending: false })
      .limit(500);
    const logo = pickLogoAsset(
      (data ?? []).map((row) => ({
        id: row.id as string,
        title: (row.title as string) ?? "",
        tags: (row.tags as string[] | null) ?? [],
        mimeType: row.mime_type as string,
        path: row.storage_path as string,
      })),
    );
    // Files sit under the workspace's own id; anything else isn't ours to read.
    if (!logo || !logo.path.startsWith(`${tenantId}/`)) return null;
    const response = await fetch(publicAssetUrl(logo.path), {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) return null;
    return { data: bytes, format: LOGO_TYPES[logo.mimeType] };
  } catch {
    return null;
  }
}

export type PoForSupplier = {
  id: string;
  number: number;
  reference: string;
  status: string;
  /** Everything the PDF's words are worked out from. */
  document: PoDocumentInput;
  /** The parts an email's "what changed" is worked out from. */
  forEmail: PoForEmail;
  /** The supplier's saved addresses, main one first. */
  supplierEmails: string[];
};

export async function loadPoForSupplier(
  supabase: SupabaseClient,
  tenant: { id: string; name: string; timezone: string; currency: string },
  which: { number: number } | { id: string },
): Promise<PoForSupplier | null> {
  const orders = supabase
    .from("purchase_orders")
    .select(
      "id, number, reference, status, notes, created_at, ordered_at, expected_on, shipping_cost, tax_rate_pct, adjustments, suppliers(name, email, contact_name, more_emails, moq, moq_applies_to), purchase_order_lines(id, stock_item_id, qty_ordered, unit_cost, supplier_sku, stock_items(title, variant_title, sku, moq))",
    )
    .eq("tenant_id", tenant.id);
  const [{ data: order }, { data: config }] = await Promise.all([
    ("id" in which ? orders.eq("id", which.id) : orders.eq("number", which.number)).maybeSingle(),
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", SHIPPING_MODULE)
      .eq("key", SHIPPING_SETTINGS_KEY)
      .maybeSingle(),
  ]);
  if (!order) return null;
  const supplier = order.suppliers as unknown as {
    name: string;
    email: string | null;
    contact_name: string | null;
    more_emails: string[] | null;
    moq: number;
    moq_applies_to: "order" | "sku";
  };
  const lines = (
    order.purchase_order_lines as unknown as {
      id: string;
      stock_item_id: string;
      qty_ordered: number;
      unit_cost: number | string;
      supplier_sku: string | null;
      stock_items: {
        title: string;
        variant_title: string | null;
        sku: string | null;
        moq: number | null;
      };
    }[]
  )
    // Always in the same order, so the same order always reads the same.
    .sort((a, b) =>
      `${a.stock_items.title}\n${a.stock_items.variant_title ?? ""}\n${a.id}`.localeCompare(
        `${b.stock_items.title}\n${b.stock_items.variant_title ?? ""}\n${b.id}`,
      ),
    );
  // The address the business ships from (Shipping's settings) is where it is.
  const from = parseShippingSettings(config?.body).ship_from;
  const reference = order.reference as string;
  const emails = [supplier.email, ...(supplier.more_emails ?? [])].filter(
    (email): email is string => Boolean(email),
  );
  return {
    id: order.id as string,
    number: order.number as number,
    reference,
    status: order.status as string,
    supplierEmails: [...new Set(emails)],
    document: {
      business: {
        name: tenant.name,
        addressLines: [from.address1, from.address2, shipFromCityLine(from), from.country],
      },
      order: {
        number: order.number as number,
        reference,
        status: order.status as string,
        createdAt: order.created_at as string,
        orderedAt: (order.ordered_at as string | null) ?? null,
        expectedOn: (order.expected_on as string | null) ?? null,
        notes: (order.notes as string | null) ?? "",
        shippingCost: String(order.shipping_cost ?? "0"),
        taxRatePct: String(order.tax_rate_pct ?? "0"),
        adjustments: order.adjustments,
      },
      supplier: {
        name: supplier.name,
        contactName: supplier.contact_name,
        email: supplier.email,
        moreEmails: supplier.more_emails ?? [],
        moq: supplier.moq,
        moqAppliesTo: supplier.moq_applies_to,
      },
      lines: lines.map((line) => ({
        sku: line.stock_items.sku,
        supplierSku: line.supplier_sku,
        title: line.stock_items.title,
        variantTitle: line.stock_items.variant_title,
        moq: line.stock_items.moq,
        qty: line.qty_ordered,
        unitCost: line.unit_cost,
      })),
      timezone: tenant.timezone,
      currency: tenant.currency,
    },
    forEmail: {
      reference,
      supplierName: supplier.name,
      contactName: supplier.contact_name,
      lines: lines.map((line) => ({
        stockItemId: line.stock_item_id,
        title: line.stock_items.variant_title
          ? `${line.stock_items.title} — ${line.stock_items.variant_title}`
          : line.stock_items.title,
        sku: line.stock_items.sku,
        supplierSku: line.supplier_sku,
        qtyOrdered: line.qty_ordered,
        unitCost: line.unit_cost,
      })),
      shippingCost: String(order.shipping_cost ?? "0"),
      taxRatePct: String(order.tax_rate_pct ?? "0"),
      adjustments: parseAdjustments(order.adjustments),
      notes: (order.notes as string | null) ?? null,
      expectedOn: (order.expected_on as string | null) ?? null,
    },
  };
}
