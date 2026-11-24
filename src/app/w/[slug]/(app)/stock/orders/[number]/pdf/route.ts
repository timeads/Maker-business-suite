import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import {
  SHIPPING_MODULE,
  SHIPPING_SETTINGS_KEY,
  parseShippingSettings,
  shipFromCityLine,
} from "@/lib/shipping/config";
import { pickLogoAsset } from "@/lib/social/photo-match";
import { publicAssetUrl } from "@/lib/social/worker";
import { buildPoDocument } from "@/lib/stock/po/document";
import { renderPoPdf, type PoLogo } from "@/lib/stock/po/pdf";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

const LOGO_TYPES: Record<string, PoLogo["format"]> = { "image/png": "png", "image/jpeg": "jpg" };
const LOGO_MAX_BYTES = 2_000_000;
/** A reference as a file name: nothing a header or a disk would trip on. */
const fileName = (reference: string) => reference.replace(/[^A-Za-z0-9._-]+/g, "-");

/**
 * The workspace's own logo: the picture tagged `logo` in its Assets, read
 * from our own storage (never an address a person typed). Only a PNG or JPEG
 * can go on a PDF; anything else, or any trouble, and the order goes without.
 */
async function loadLogo(supabase: SupabaseClient, tenantId: string): Promise<PoLogo | null> {
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

/**
 * One order as a PDF, as the supplier will receive it. Owners and admins
 * only, like placing the order itself.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; number: string }> },
) {
  const { slug, number } = await params;
  const user = await requireUser(`/w/${slug}/stock/orders/${number}`);
  const ctx = await getTenantContext(slug, user.id);
  const missing = new NextResponse("Not found", { status: 404 });
  if (!ctx || !/^\d{1,9}$/.test(number) || !canManage(ctx.role)) return missing;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.stock")) return missing;

  const supabase = await createClient();
  const [{ data: order }, { data: config }, logo] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select(
        "number, reference, status, notes, created_at, ordered_at, expected_on, shipping_cost, tax_rate_pct, adjustments, suppliers(name, email, contact_name, more_emails, moq, moq_applies_to), purchase_order_lines(id, qty_ordered, unit_cost, supplier_sku, stock_items(title, variant_title, sku, moq))",
      )
      .eq("tenant_id", ctx.tenant.id)
      .eq("number", Number(number))
      .maybeSingle(),
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", ctx.tenant.id)
      .eq("module", SHIPPING_MODULE)
      .eq("key", SHIPPING_SETTINGS_KEY)
      .maybeSingle(),
    loadLogo(supabase, ctx.tenant.id),
  ]);
  if (!order) return missing;
  const supplier = order.suppliers as unknown as {
    name: string;
    email: string | null;
    contact_name: string | null;
    more_emails: string[] | null;
    moq: number;
    moq_applies_to: "order" | "sku";
  };
  const lines = order.purchase_order_lines as unknown as {
    id: string;
    qty_ordered: number;
    unit_cost: number | string;
    supplier_sku: string | null;
    stock_items: {
      title: string;
      variant_title: string | null;
      sku: string | null;
      moq: number | null;
    };
  }[];
  // The address the business ships from (Shipping's settings) is where it is.
  const from = parseShippingSettings(config?.body).ship_from;
  const doc = buildPoDocument({
    business: {
      name: ctx.tenant.name,
      addressLines: [from.address1, from.address2, shipFromCityLine(from), from.country],
    },
    order: {
      number: order.number as number,
      reference: order.reference as string,
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
    timezone: ctx.tenant.timezone,
    currency: ctx.tenant.currency,
  });
  const pdf = await renderPoPdf(doc, logo);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${fileName(order.reference as string)}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
