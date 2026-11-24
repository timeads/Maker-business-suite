"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { downloadEasyPostLabel, isEasyPostFileLink } from "@/lib/shipping/sources/files";
import { printKind, type PrintLabel } from "@/lib/shipping/zebra/labels";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import {
  loadSlipRun,
  slipsToPrint,
  type SlipPrinted,
  type SlipSelection,
  type SlipToPrint,
} from "./slips-data";

export type LabelPrintData = {
  error?: string;
  /** Every box's label this computer can send to its Zebra, in box order. */
  labels?: PrintLabel[];
  /** Boxes whose label can't go to a Zebra from here (a file we don't hold, or no longer have). */
  unprintable?: number;
  /** When it was last printed, on any computer. */
  printedAt?: string | null;
  printCount?: number;
};

const UUID = /^[0-9a-f-]{36}$/i;
const NO_ACCESS = "Shipping isn't part of this workspace's plan right now.";
const NOT_FOUND = "We couldn't find that label.";

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/shipping`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.shipping")) return { error: NO_ACCESS } as const;
  return { tenant: ctx.tenant, entitlements, supabase: await createClient() } as const;
}

type Parcel = {
  id: string;
  label_provider: string | null;
  label_url: string | null;
  label_parcels: unknown;
  merged_with: string | null;
  voided_at: string | null;
  label_printed_at: string | null;
  label_print_count: number | null;
};
const PARCEL =
  "id, label_provider, label_url, label_parcels, merged_with, voided_at, label_printed_at, label_print_count";

/**
 * A parcel's label, for the computer that asked to send to its own Zebra.
 * Read as the signed-in member, so row-level security decides whether the
 * parcel and its label files are theirs to see. Labels kept as ZPL go as they
 * are; ones kept as a picture or a PDF are drawn for the printer in the browser. An
 * EasyPost label we hold only a link to is fetched from EasyPost's own file
 * store, and from nowhere else.
 */
export async function getLabelPrintData(
  slug: string,
  shipmentId: string,
  /** Just this box's label, for a bench that packs and labels one box at a time. Counting from 1. */
  box?: number,
): Promise<LabelPrintData> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const onlyBox =
    typeof box === "number" && Number.isInteger(box) && box >= 1 && box <= 6 ? box : 0;
  if (!UUID.test(shipmentId)) return { error: NOT_FOUND };
  const load = async (id: string) => {
    const { data } = await ctx.supabase
      .from("shipments")
      .select(PARCEL)
      .eq("tenant_id", ctx.tenant.id)
      .eq("id", id)
      .maybeSingle();
    return data as Parcel | null;
  };
  let parcel = await load(shipmentId);
  // An order that rode along: the label is on the parcel it went in.
  if (parcel?.merged_with) parcel = await load(parcel.merged_with);
  if (!parcel || !parcel.label_provider) return { error: NOT_FOUND };
  if (parcel.voided_at) return { error: "This label was voided, so it can't be printed." };

  const raw = Array.isArray(parcel.label_parcels) ? (parcel.label_parcels as unknown[]) : [];
  const boxes = (raw.length > 0 ? raw : [{ label_url: parcel.label_url }]).map((box) => {
    const item = box && typeof box === "object" ? (box as Record<string, unknown>) : {};
    return {
      file:
        typeof item.label_file === "string" && UUID.test(item.label_file) ? item.label_file : "",
      link: typeof item.label_url === "string" ? item.label_url : "",
    };
  });
  const fileIds = boxes.map((box) => box.file).filter(Boolean);
  const files = new Map<string, { content_type: string; data: string }>();
  if (fileIds.length > 0) {
    const { data } = await ctx.supabase
      .from("shipping_label_files")
      .select("id, content_type, data")
      .eq("tenant_id", ctx.tenant.id)
      .in("id", fileIds);
    for (const row of (data ?? []) as { id: string; content_type: string; data: string }[]) {
      files.set(row.id, row);
    }
  }

  const labels: PrintLabel[] = [];
  let unprintable = 0;
  if (onlyBox > boxes.length) return { error: NOT_FOUND };
  for (const [index, box] of boxes.entries()) {
    if (onlyBox && index + 1 !== onlyBox) continue;
    let file = files.get(box.file) ?? null;
    if (!file && parcel.label_provider === "easypost" && isEasyPostFileLink(box.link)) {
      const fetched = await downloadEasyPostLabel(box.link);
      file = fetched ? { content_type: fetched.contentType, data: fetched.data } : null;
    }
    const kind = file ? printKind(file.content_type) : null;
    if (!file || !kind) {
      unprintable += 1;
      continue;
    }
    labels.push({
      box: index + 1,
      kind,
      data: file.data,
      // Redo's pictures can sit inside wide white margins.
      ...(parcel.label_provider === "redo" && (kind === "png" || kind === "gif")
        ? { crop: true }
        : {}),
    });
  }
  if (onlyBox) {
    // When this one box's label was last printed. Read on its own: without it, nothing is known.
    const { data: noted } = await ctx.supabase
      .from("shipments")
      .select("label_boxes_printed")
      .eq("tenant_id", ctx.tenant.id)
      .eq("id", parcel.id)
      .maybeSingle();
    const when = (noted as { label_boxes_printed?: Record<string, unknown> } | null)
      ?.label_boxes_printed?.[String(onlyBox)];
    return {
      labels,
      unprintable,
      printedAt: typeof when === "string" ? when : null,
      printCount: typeof when === "string" ? 1 : 0,
    };
  }
  return {
    labels,
    unprintable,
    printedAt: parcel.label_printed_at,
    printCount: parcel.label_print_count ?? 0,
  };
}

/** Says this parcel's label went to a printer, so the next person is warned before a second copy. */
export async function markLabelPrinted(
  slug: string,
  shipmentId: string,
  /** Only this box's label was printed (counting from 1). */
  box?: number,
): Promise<{ printedAt?: string; error?: string }> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(shipmentId)) return { error: NOT_FOUND };
  // A read-only workspace can still print what it bought; it just isn't written down.
  if (!ctx.entitlements.canWrite) return {};
  const oneBox = typeof box === "number" && Number.isInteger(box) && box >= 1 && box <= 6;
  const { data, error } = oneBox
    ? await ctx.supabase.rpc("mark_label_box_printed", { p_shipment_id: shipmentId, p_box: box })
    : await ctx.supabase.rpc("mark_label_printed", { p_shipment_id: shipmentId });
  if (error) {
    console.error("could not mark label printed", error.message);
    return { error: "It printed, but we couldn't note that here." };
  }
  revalidatePath(`/w/${slug}/shipping`, "layout");
  const printedAt = (data as { printed_at?: unknown } | null)?.printed_at;
  return typeof printedAt === "string" ? { printedAt } : {};
}

export type SlipPrintData = {
  error?: string;
  slips?: SlipToPrint[];
  /** Orders among them whose slip was printed before. */
  printed?: SlipPrinted[];
};

/**
 * The packing slips a press asks for, as plain words, for the computer that
 * sends them to its own Zebra. The same choice of slips as the slips page
 * shows for the same link.
 */
export async function getSlipPrintData(
  slug: string,
  selection: SlipSelection,
): Promise<SlipPrintData> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const picked = selection && typeof selection === "object" ? selection : {};
  const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 6000) : undefined);
  const run = await loadSlipRun(ctx.supabase, ctx.tenant, {
    order: text(picked.order),
    ids: text(picked.ids),
    together: text(picked.together),
    all: text(picked.all),
    parcel: text(picked.parcel),
  });
  return slipsToPrint(run, ctx.tenant);
}

/** Notes that these orders' slips went to a printer, so the next run leaves them out. */
export async function noteSlipsPrinted(slug: string, ids: string[]): Promise<{ error?: string }> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  // A read-only workspace can still print; it just isn't written down.
  if (!ctx.entitlements.canWrite) return {};
  const clean = (Array.isArray(ids) ? ids : [])
    .filter((id) => typeof id === "string" && UUID.test(id))
    .slice(0, 500);
  if (clean.length === 0) return {};
  const { error } = await ctx.supabase.rpc("mark_slips_printed", {
    p_tenant_id: ctx.tenant.id,
    p_ids: clean,
  });
  if (error) {
    console.error("could not mark slips printed", error.message);
    return { error: "They printed, but we couldn't note that here." };
  }
  revalidatePath(`/w/${slug}/shipping`, "layout");
  return {};
}
