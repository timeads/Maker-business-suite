"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireUser } from "@/lib/auth";
import { localDay } from "@/lib/bookings/slots";
import { getEntitlements } from "@/lib/entitlements";
import {
  MAX_IMPORT_BYTES,
  isImportKind,
  readImport,
  type ImportKind,
  type ItemRef,
  type Problem,
} from "@/lib/stock/import/files";
import type { ImportCounts } from "@/lib/stock/import/words";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type ImportLook = {
  kind: ImportKind;
  fileName: string;
  /** Rows the file held. */
  read: number;
  /** Rows we could use. */
  usable: number;
  counts: ImportCounts;
  /** The first of the rows left out, each with why; `problemCount` is all of them. */
  problems: Problem[];
  problemCount: number;
  notes: string[];
  /** What this look came to, handed back with "Bring these in" so a changed picture is caught. */
  seen: string;
};
export type ImportState = {
  error?: string;
  look?: ImportLook;
  /** Set with `look` when the records changed between looking and pressing. */
  moved?: boolean;
  done?: { kind: ImportKind; fileName: string; counts: ImportCounts; repeated: boolean };
};

const NO_ACCESS = "Stock isn't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can bring records in.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't work, and nothing was changed. Please try again.";
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOWN_PROBLEMS = 200;
const PAGE = 1000;

const FUNCTIONS: Record<ImportKind, string> = {
  suppliers: "import_suppliers",
  items: "import_item_planning",
  orders: "import_purchase_orders",
  ledger: "import_ledger_entries",
  counts: "import_daily_counts",
  deliveries: "import_deliveries",
};
/** Files whose rows name items, so the workspace's items are needed to place them. */
const NEEDS_ITEMS: ImportKind[] = ["items", "orders", "counts", "deliveries"];

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/stock/settings/import`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.stock")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  if (!canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  return { tenant: ctx.tenant, supabase: await createClient() } as const;
}

/** Every item's id and what it is called, a page at a time. */
async function loadItems(supabase: SupabaseClient, tenantId: string): Promise<ItemRef[] | null> {
  const items: ItemRef[] = [];
  for (let from = 0; from < 60_000; from += PAGE) {
    const { data, error } = await supabase
      .from("stock_items")
      .select("id, sku, title, variant_title")
      .eq("tenant_id", tenantId)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) return null;
    items.push(...((data ?? []) as ItemRef[]));
    if ((data ?? []).length < PAGE) break;
  }
  return items;
}

const tidyCounts = (raw: unknown): ImportCounts & { repeated: boolean } => {
  const value = (raw ?? {}) as Record<string, unknown>;
  const n = (key: string) => (typeof value[key] === "number" ? (value[key] as number) : 0);
  return {
    new: n("new"),
    changed: n("changed"),
    same: n("same"),
    ...("suppliers_added" in value ? { suppliers_added: n("suppliers_added") } : {}),
    ...("lines" in value ? { lines: n("lines") } : {}),
    ...("unmatched" in value ? { unmatched: n("unmatched") } : {}),
    repeated: value.repeated === true,
  };
};

/**
 * Reads the file and asks the database what bringing it in would do. The
 * database works that out by doing the whole import and then undoing it, so
 * the answer is exact and nothing is written.
 */
async function look(
  ctx: Extract<Awaited<ReturnType<typeof context>>, { tenant: unknown }>,
  kind: ImportKind,
  fileName: string,
  text: string,
): Promise<{ error: string } | { look: ImportLook; payload: Record<string, unknown>[] }> {
  if (typeof text !== "string" || text.length > MAX_IMPORT_BYTES) {
    return {
      error: `That file is bigger than ${MAX_IMPORT_BYTES / 1_000_000} MB. Split it into smaller files and bring them in one at a time.`,
    };
  }
  let items: ItemRef[] = [];
  if (NEEDS_ITEMS.includes(kind)) {
    const loaded = await loadItems(ctx.supabase, ctx.tenant.id);
    if (!loaded) return { error: OOPS };
    if (loaded.length === 0) {
      return {
        error:
          "There are no items here yet to match this file to. Connect your shop and let it sync first, then bring this file in.",
      };
    }
    items = loaded;
  }
  const now = new Date();
  const read = readImport(kind, text, {
    items,
    today: localDay(now, ctx.tenant.timezone),
    now: now.toISOString(),
  });
  if (!read.ok) return { error: read.error };

  const { data, error } = await ctx.supabase.rpc(FUNCTIONS[kind], {
    p_tenant_id: ctx.tenant.id,
    p_request_key: null,
    p_rows: read.payload,
    p_file_name: fileName,
    p_confirm: false,
  });
  if (error) {
    console.error(`stock import look (${kind}) failed`, error.code, error.message);
    return {
      error:
        "We read the file, but couldn't work out what bringing it in would change. Nothing was changed. Check the file against the guide and try again.",
    };
  }
  const { repeated: _repeated, ...counts } = tidyCounts(data);
  return {
    payload: read.payload,
    look: {
      kind,
      fileName,
      read: read.read,
      usable: read.payload.length,
      counts,
      problems: read.problems.slice(0, SHOWN_PROBLEMS),
      problemCount: read.problems.length,
      notes: read.notes,
      seen: JSON.stringify([read.payload.length, counts]),
    },
  };
}

const cleanName = (name: string) =>
  String(name ?? "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .slice(0, 200);

/** Step one: read the file and show what bringing it in would do. Writes nothing. */
export async function lookAtImport(
  slug: string,
  kind: string,
  fileName: string,
  text: string,
): Promise<ImportState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!isImportKind(kind)) return { error: OOPS };
  const result = await look(ctx, kind, cleanName(fileName), text);
  return "error" in result ? { error: result.error } : { look: result.look };
}

/**
 * Step two: bring it in. The file is read again from scratch (nothing from
 * the first look is trusted), and if what it would do is no longer what the
 * person was shown, nothing is written and they are shown the new picture.
 * The key makes a second press find the first one's result.
 */
export async function runImport(
  slug: string,
  kind: string,
  fileName: string,
  text: string,
  requestKey: string,
  seen: string,
): Promise<ImportState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!isImportKind(kind) || !KEY.test(requestKey)) return { error: OOPS };
  const name = cleanName(fileName);

  // A second press of the same button: say what the first one did.
  const { data: earlier } = await ctx.supabase
    .from("stock_imports")
    .select("counts")
    .eq("tenant_id", ctx.tenant.id)
    .eq("request_key", requestKey)
    .maybeSingle();
  if (earlier) {
    const { repeated: _repeated, ...counts } = tidyCounts(earlier.counts);
    return { done: { kind, fileName: name, counts, repeated: true } };
  }

  const result = await look(ctx, kind, name, text);
  if ("error" in result) return { error: result.error };
  if (result.look.seen !== seen) return { look: result.look, moved: true };
  if (result.payload.length === 0) {
    return { error: "There is nothing in that file we can bring in." };
  }

  const { data, error } = await ctx.supabase.rpc(FUNCTIONS[kind], {
    p_tenant_id: ctx.tenant.id,
    p_request_key: requestKey,
    p_rows: result.payload,
    p_file_name: name,
    p_confirm: true,
  });
  if (error) {
    console.error(`stock import (${kind}) failed`, error.code, error.message);
    return { error: OOPS };
  }
  const { repeated, ...counts } = tidyCounts(data);
  revalidatePath(`/w/${slug}/stock`, "layout");
  return { done: { kind, fileName: name, counts, repeated } };
}
