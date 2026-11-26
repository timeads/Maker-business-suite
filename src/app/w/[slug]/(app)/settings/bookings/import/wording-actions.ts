"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { BOOKINGS_MODULE } from "@/lib/bookings/config";
import { readEmailSettings } from "@/lib/bookings/email-settings";
import { readWording, type WordingRow } from "@/lib/bookings/import/wording";
import { WORDS_KEY } from "@/lib/bookings/words";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { TEXTS_KEY, parseTextSettings } from "@/lib/texts/config";

export type WordingState = {
  error?: string;
  look?: { rows: WordingRow[]; problems: { line: number; reason: string }[] };
  done?: string;
};

const MAX_BYTES = 500_000;

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/settings/bookings/import`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: "Bookings aren't part of this workspace's plan right now." } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.bookings")) {
    return { error: "Bookings aren't part of this workspace's plan right now." } as const;
  }
  if (!entitlements.canWrite) {
    return { error: "This workspace is read-only because its plan has ended." } as const;
  }
  if (!canManage(ctx.role))
    return { error: "Only owners and admins can bring wording in." } as const;
  return { tenant: ctx.tenant, supabase: await createClient() } as const;
}

/**
 * The earlier app's message wording, read against the settings as they are
 * now. With `save` false it only looks; with `save` true it writes both
 * configs through `save_config` (`private.write_config`, so each leaves a
 * `config_versions` row). Nothing is sent and no text is switched on.
 */
export async function bringWording(
  slug: string,
  text: string,
  save: boolean,
): Promise<WordingState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (typeof text !== "string" || text.length > MAX_BYTES) {
    return { error: "That file is too big for message wording." };
  }
  const { words } = await readEmailSettings(ctx.supabase, ctx.tenant.id);
  const { data: texts } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", BOOKINGS_MODULE)
    .eq("key", TEXTS_KEY)
    .maybeSingle();
  const read = readWording(text, {
    emailWords: words,
    textSettings: parseTextSettings(texts?.body),
  });
  if (!read.ok) return { error: read.error };
  const look = { rows: read.rows, problems: read.problems };
  if (!save) return { look };
  if (read.rows.length === 0) return { error: "Nothing in that file can be used.", look };
  const hasEmail = read.rows.some((row) => row.channel === "email");
  const hasText = read.rows.some((row) => row.channel === "text");
  for (const [key, body, wanted] of [
    [WORDS_KEY, read.emailWords, hasEmail],
    [TEXTS_KEY, read.textSettings, hasText],
  ] as const) {
    if (!wanted) continue;
    const { error } = await ctx.supabase.rpc("save_config", {
      p_tenant_id: ctx.tenant.id,
      p_module: BOOKINGS_MODULE,
      p_key: key,
      p_body: body,
    });
    if (error) return { error: "That didn't save. Please try again.", look };
  }
  revalidatePath(`/w/${slug}/settings`, "layout");
  return {
    look,
    done: `Brought in ${read.rows.length} message${read.rows.length === 1 ? "" : "s"}. Check them under Email words${hasText ? " and Text reminders" : ""}.`,
  };
}
