"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import {
  MAX_BOOKING_IMPORT_BYTES,
  isBookingImportKind,
  readBookingImport,
  type BookingImportKind,
  type Problem,
} from "@/lib/bookings/import/files";
import type { BookingImportCounts } from "@/lib/bookings/import/words";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type BookingImportLook = {
  kind: BookingImportKind;
  fileName: string;
  read: number;
  usable: number;
  counts: BookingImportCounts;
  /** The first of the rows left out, here and by the database, each with why. */
  problems: Problem[];
  problemCount: number;
  notes: string[];
  /** What this look came to, handed back with "Bring these in" so a changed picture is caught. */
  seen: string;
};
export type BookingImportState = {
  error?: string;
  look?: BookingImportLook;
  moved?: boolean;
  done?: {
    kind: BookingImportKind;
    fileName: string;
    counts: BookingImportCounts;
    repeated: boolean;
  };
};

const NO_ACCESS = "Bookings aren't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can bring bookings in.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't work, and nothing was changed. Please try again.";
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOWN_PROBLEMS = 200;

const FUNCTIONS: Record<BookingImportKind, string> = {
  workshops: "import_booking_workshops",
  dates: "import_booking_dates",
  bookings: "import_bookings",
};

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/settings/bookings/import`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.bookings")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  if (!canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  return { tenant: ctx.tenant, supabase: await createClient() } as const;
}

const tidyCounts = (raw: unknown): BookingImportCounts & { repeated: boolean } => {
  const value = (raw ?? {}) as Record<string, unknown>;
  const n = (key: string) => (typeof value[key] === "number" ? (value[key] as number) : 0);
  const refused = Array.isArray(value.refused)
    ? (value.refused as unknown[])
        .map((item) => item as { line?: unknown; reason?: unknown })
        .filter((item) => typeof item.line === "number" && typeof item.reason === "string")
        .map((item) => ({ line: item.line as number, reason: item.reason as string }))
    : [];
  return {
    new: n("new"),
    changed: n("changed"),
    same: n("same"),
    refused,
    ...("ids_not_kept" in value ? { ids_not_kept: n("ids_not_kept") } : {}),
    ...("shared_rooms" in value ? { shared_rooms: n("shared_rooms") } : {}),
    ...("oversold" in value ? { oversold: n("oversold") } : {}),
    ...("emails_marked" in value ? { emails_marked: n("emails_marked") } : {}),
    repeated: value.repeated === true,
  };
};

/**
 * Reads the file and asks the database what bringing it in would do. The
 * database works that out by doing the whole import and then undoing it.
 */
async function look(
  ctx: Extract<Awaited<ReturnType<typeof context>>, { tenant: unknown }>,
  kind: BookingImportKind,
  fileName: string,
  text: string,
): Promise<{ error: string } | { look: BookingImportLook; payload: Record<string, unknown>[] }> {
  if (typeof text !== "string" || text.length > MAX_BOOKING_IMPORT_BYTES) {
    return {
      error: `That file is bigger than ${MAX_BOOKING_IMPORT_BYTES / 1_000_000} MB. Split it into smaller files and bring them in one at a time.`,
    };
  }
  const read = readBookingImport(kind, text, { timeZone: ctx.tenant.timezone });
  if (!read.ok) return { error: read.error };

  const { data, error } = await ctx.supabase.rpc(FUNCTIONS[kind], {
    p_tenant_id: ctx.tenant.id,
    p_request_key: null,
    p_rows: read.payload,
    p_file_name: fileName,
    p_confirm: false,
  });
  if (error) {
    console.error(`bookings import look (${kind}) failed`, error.code, error.message);
    return {
      error:
        "We read the file, but couldn't work out what bringing it in would change. Nothing was changed. Check the file against the guide and try again.",
    };
  }
  const { repeated: _repeated, ...counts } = tidyCounts(data);
  const problems = [...read.problems, ...counts.refused].sort((a, b) => a.line - b.line);
  return {
    payload: read.payload,
    look: {
      kind,
      fileName,
      read: read.read,
      usable: read.payload.length - counts.refused.length,
      counts,
      problems: problems.slice(0, SHOWN_PROBLEMS),
      problemCount: problems.length,
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
export async function lookAtBookingImport(
  slug: string,
  kind: string,
  fileName: string,
  text: string,
): Promise<BookingImportState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!isBookingImportKind(kind)) return { error: OOPS };
  const result = await look(ctx, kind, cleanName(fileName), text);
  return "error" in result ? { error: result.error } : { look: result.look };
}

/**
 * Step two: bring it in. The file is read again from scratch, and if what it
 * would do is no longer what the person was shown, nothing is written and
 * they are shown the new picture. The key makes a second press find the first.
 */
export async function runBookingImport(
  slug: string,
  kind: string,
  fileName: string,
  text: string,
  requestKey: string,
  seen: string,
): Promise<BookingImportState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!isBookingImportKind(kind) || !KEY.test(requestKey)) return { error: OOPS };
  const name = cleanName(fileName);

  const { data: earlier } = await ctx.supabase
    .from("booking_imports")
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
  if (result.look.usable <= 0) {
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
    console.error(`bookings import (${kind}) failed`, error.code, error.message);
    return { error: OOPS };
  }
  const { repeated, ...counts } = tidyCounts(data);
  revalidatePath(`/w/${slug}/bookings`, "layout");
  revalidatePath(`/w/${slug}/settings`, "layout");
  return { done: { kind, fileName: name, counts, repeated } };
}
