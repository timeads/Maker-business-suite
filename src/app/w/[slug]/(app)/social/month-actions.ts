"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { loadBrands } from "@/lib/brand/brands";
import { getEntitlements } from "@/lib/entitlements";
import { PLAN_KEY, SOCIAL_MODULE, parsePlan, socialPlanSchema } from "@/lib/social/plan";
import {
  SUGGEST_FROM,
  addNotes,
  styleNotesKey,
  styleNotesSchema,
  suggestStyleNotes,
  tidySuggestions,
} from "@/lib/social/style-notes";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type MonthState = { error?: string; message?: string; notes?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OOPS = "That didn't save. Please try again.";

/** Owners and admins of a workspace that has Social and can write. */
async function managerContext(slug: string, from: string) {
  const user = await requireUser(from);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: "We couldn't find that workspace." } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.social")) {
    return { error: "Social isn't part of this workspace's plan right now." } as const;
  }
  if (!entitlements.canWrite) {
    return { error: "This workspace is read-only because its plan has ended." } as const;
  }
  if (!canManage(ctx.role)) {
    return { error: "Only owners and admins can change this." } as const;
  }
  return { user, ctx, entitlements, supabase: await createClient() } as const;
}

const done = (slug: string) => {
  revalidatePath(`/w/${slug}/social`, "layout");
  revalidatePath(`/w/${slug}/settings`, "layout");
};

/**
 * Saves each brand's review day, and whether the month drafts itself. The
 * rest of the plan is kept as it is. Owners and admins only (and
 * `save_config` checks again).
 */
export async function saveReviewDays(
  slug: string,
  _prev: MonthState,
  formData: FormData,
): Promise<MonthState> {
  const got = await managerContext(slug, `/w/${slug}/social/plan`);
  if ("error" in got) return { error: got.error };
  const { ctx, supabase } = got;
  const [{ data: row }, brands] = await Promise.all([
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", ctx.tenant.id)
      .eq("module", SOCIAL_MODULE)
      .eq("key", PLAN_KEY)
      .maybeSingle(),
    loadBrands(supabase, ctx.tenant.id),
  ]);
  const plan = parsePlan(row?.body);
  const reviewDays = brands
    .filter((brand) => !brand.archived_at && formData.get(`week_${brand.id}`))
    .flatMap((brand) => {
      const week = Number(formData.get(`week_${brand.id}`));
      if (!week) return [];
      return [
        {
          // The main brand's day names no brand, so it follows whichever brand is main.
          brand_id: brand.is_default ? null : brand.id,
          week,
          weekday: Number(formData.get(`weekday_${brand.id}`) ?? 1),
          lead_days: Number(formData.get(`lead_${brand.id}`) ?? 0),
          auto: formData.get(`auto_${brand.id}`) === "on",
        },
      ];
    });
  const parsed = socialPlanSchema.safeParse({ ...plan, review_days: reviewDays });
  if (!parsed.success) {
    return { error: "Check the review days: a week of the month, a day, and 0 to 21 days ahead." };
  }
  const { error } = await supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: SOCIAL_MODULE,
    p_key: PLAN_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  done(slug);
  const auto = reviewDays.filter((day) => day.auto).length;
  return {
    message:
      auto > 0
        ? "Saved. The month will be drafted by itself for you to review."
        : "Saved. Nothing is drafted by itself until you switch it on.",
  };
}

const RUN_REFUSALS: Record<string, string> = {
  no_review_day: "Set this brand's review day first, then save.",
  already_drafted:
    "That month has already been drafted. Its drafts are in Review; you can still use Draft the month for more.",
  too_soon: "A run was asked for a few minutes ago. Give it a little while.",
  "Brand not found": "Pick one of your brands (not one that's put away).",
};

/** "Run it now": the same claim the schedule uses, so a month can't be drafted twice. */
export async function runMonthNow(
  slug: string,
  _prev: MonthState,
  formData: FormData,
): Promise<MonthState> {
  const got = await managerContext(slug, `/w/${slug}/social/plan`);
  if ("error" in got) return { error: got.error };
  if (!process.env.ANTHROPIC_API_KEY) {
    return { error: "Drafting isn't switched on for this environment yet." };
  }
  const brandId = String(formData.get("brand_id") ?? "");
  const { error } = await got.supabase.rpc("request_social_month_run", {
    p_tenant_id: got.ctx.tenant.id,
    p_brand_id: UUID.test(brandId) ? brandId : null,
  });
  if (error) {
    const known = Object.keys(RUN_REFUSALS).find((key) => error.message.includes(key));
    return { error: known ? RUN_REFUSALS[known] : "That didn't start. Please try again." };
  }
  done(slug);
  return {
    message:
      "Started. The drafts arrive in Review over the next few minutes; you'll get a heads-up in Messages.",
  };
}

/** Saves a brand's style notes as a person wrote them. */
export async function saveStyleNotes(
  slug: string,
  _prev: MonthState,
  formData: FormData,
): Promise<MonthState> {
  const got = await managerContext(slug, `/w/${slug}/settings/social/style`);
  if ("error" in got) return { error: got.error };
  const brands = await loadBrands(got.supabase, got.ctx.tenant.id);
  const brand = brands.find((b) => b.id === String(formData.get("brand_id") ?? "")) ?? null;
  if (brands.length > 0 && !brand) return { error: "Pick one of your brands." };
  const parsed = styleNotesSchema.safeParse({
    version: 1,
    notes: String(formData.get("notes") ?? "").replace(/\r\n?/g, "\n"),
  });
  if (!parsed.success) return { error: "Keep the notes under 4,000 characters." };
  const { error } = await got.supabase.rpc("save_config", {
    p_tenant_id: got.ctx.tenant.id,
    p_module: SOCIAL_MODULE,
    p_key: styleNotesKey(brand),
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Style notes saved. Claude reads them before every draft." };
}

/**
 * "Suggest notes from my edits": Claude reads the brand's recent edits and
 * proposes notes. They only fill the editor; nothing is saved here.
 */
export async function suggestNotesFromEdits(
  slug: string,
  _prev: MonthState,
  formData: FormData,
): Promise<MonthState> {
  const got = await managerContext(slug, `/w/${slug}/settings/social/style`);
  if ("error" in got) return { error: got.error };
  const { ctx, supabase, entitlements } = got;
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_SECRET_KEY) {
    return { error: "Suggestions aren't switched on for this environment yet." };
  }
  const brands = await loadBrands(supabase, ctx.tenant.id);
  const brand = brands.find((b) => b.id === String(formData.get("brand_id") ?? "")) ?? null;
  const current = String(formData.get("notes") ?? "").slice(0, 4000);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  let edits = supabase
    .from("social_post_edits")
    .select("before, after")
    .eq("tenant_id", ctx.tenant.id)
    .order("edited_at", { ascending: false })
    .limit(SUGGEST_FROM);
  if (brand) edits = edits.eq("brand_id", brand.id);
  const [{ data: rows }, { data: usage }] = await Promise.all([
    edits,
    supabase
      .from("usage_events")
      .select("quantity")
      .eq("tenant_id", ctx.tenant.id)
      .eq("type", "ai_tokens")
      .gte("occurred_at", monthStart.toISOString()),
  ]);
  const pairs = ((rows ?? []) as { before: string; after: string }[]).map((row) => ({
    before: row.before.slice(0, 900),
    after: row.after.slice(0, 900),
  }));
  if (pairs.length < 2) {
    return {
      error:
        "There aren't enough edits to learn from yet. Change a few of Claude's drafts before posting them, then try again.",
    };
  }
  const used = (usage ?? []).reduce((sum, row) => sum + Number(row.quantity), 0);
  if (used >= entitlements.limit("ai_credits")) {
    return { error: "You've used this month's AI allowance. It resets next month." };
  }
  try {
    const result = await suggestStyleNotes({
      business: brand && !brand.is_default ? brand.name : ctx.tenant.name,
      current,
      edits: pairs,
    });
    const { error: usageError } = await getAdminClient().rpc("record_usage", {
      p_tenant_id: ctx.tenant.id,
      p_type: "ai_tokens",
      p_quantity: result.tokens,
    });
    if (usageError) console.error(`Could not record AI usage: ${usageError.message}`);
    if (!result.ok) return { error: "Claude couldn't suggest anything this time." };
    const additions = tidySuggestions(result.raw, current);
    if (additions.length === 0) {
      return { message: "Nothing new stood out in your edits. Your notes already cover them." };
    }
    return {
      notes: addNotes(current, additions),
      message: `${additions.length} suggestion${additions.length === 1 ? "" : "s"} added below. Read them, change anything, then save.`,
    };
  } catch (err) {
    console.error("Style note suggestion failed", err instanceof Error ? err.message : err);
    return { error: "Suggesting didn't work just now. Please try again." };
  }
}
