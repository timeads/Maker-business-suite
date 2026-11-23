"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { APPEARANCE_KEY, appearanceSchema } from "@/lib/brand/appearance";
import { draftBrandKit, type BrandGuide } from "@/lib/brand/draft";
import {
  BRAND_MODULE,
  FEELS,
  KIT_KEY,
  brandKitSchema,
  tidyColorName,
  tidyHex,
  type BrandKitConfig,
} from "@/lib/brand/kit";
import { getEntitlements } from "@/lib/entitlements";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type BrandState = {
  error?: string;
  saved?: boolean;
  /** A kit Claude suggested. Shown for editing; never saved by itself. */
  draft?: BrandKitConfig;
  /** Changes with every suggestion so the editor starts afresh from it. */
  draftId?: number;
};

const MAX_GUIDE_BYTES = 5 * 1024 * 1024;

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/settings/brand`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: "We couldn't find that workspace." } as const;
  if (!canManage(ctx.role)) {
    return { error: "Only owners and admins can change the brand kit." } as const;
  }
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.canWrite) {
    return {
      error: "This workspace is read-only because its plan has ended. Pick a plan to make changes.",
    } as const;
  }
  return { tenant: ctx.tenant, entitlements, supabase: await createClient() } as const;
}

const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "")
    .trim()
    .slice(0, max);

const tidySite = (value: string) =>
  value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .slice(0, 80);

async function readGuide(formData: FormData): Promise<BrandGuide | { error: string }> {
  const file = formData.get("guide_file");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_GUIDE_BYTES) return { error: "Brand guides can be up to 5 MB." };
    const kind =
      file.type === "application/pdf"
        ? "pdf"
        : file.type === "image/png" || file.type === "image/jpeg"
          ? "image"
          : null;
    if (!kind) return { error: "Upload a PDF, PNG or JPEG, or paste the words instead." };
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    return kind === "pdf"
      ? { kind, base64 }
      : { kind, base64, mediaType: file.type as "image/png" | "image/jpeg" };
  }
  const pasted = text(formData, "guide_text", 20000);
  if (pasted.length < 40) {
    return { error: "Upload your brand guide, or paste what it says (a few sentences at least)." };
  }
  return { kind: "text", text: pasted };
}

/** Asks Claude to suggest a kit, from answers or from an uploaded guide. Saves nothing. */
export async function suggestKit(
  slug: string,
  _prev: BrandState,
  formData: FormData,
): Promise<BrandState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_SECRET_KEY) {
    return {
      error: "Drafting isn't switched on for this environment yet. You can fill it in by hand.",
    };
  }
  const site = tidySite(text(formData, "site", 120));
  const base = { workspaceName: ctx.tenant.name, site };
  let input: Parameters<typeof draftBrandKit>[0];
  if (formData.get("from") === "guide") {
    const guide = await readGuide(formData);
    if ("error" in guide) return { error: guide.error };
    input = { ...base, from: "guide", guide };
  } else {
    const makes = text(formData, "makes", 600);
    if (makes.length < 10) return { error: "Tell us a little about what you make first." };
    const feel = text(formData, "feel", 20);
    input = {
      ...base,
      from: "answers",
      answers: {
        makes,
        customers: text(formData, "customers", 600),
        personality: text(formData, "personality", 600),
        colours: text(formData, "colours", 300),
        feel: (FEELS as readonly string[]).includes(feel) ? feel : "minimal",
      },
    };
  }

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data: usage } = await ctx.supabase
    .from("usage_events")
    .select("quantity")
    .eq("tenant_id", ctx.tenant.id)
    .eq("type", "ai_tokens")
    .gte("occurred_at", monthStart.toISOString());
  const used = (usage ?? []).reduce((sum, row) => sum + Number(row.quantity), 0);
  if (used >= ctx.entitlements.limit("ai_credits")) {
    return { error: "This month's Claude allowance is used up. You can still fill it in by hand." };
  }

  try {
    const draft = await draftBrandKit(input);
    const { error: usageError } = await getAdminClient().rpc("record_usage", {
      p_tenant_id: ctx.tenant.id,
      p_type: "ai_tokens",
      p_quantity: draft.tokens,
    });
    if (usageError) console.error(`Could not record AI usage: ${usageError.message}`);
    if (!draft.ok) {
      return {
        error:
          input.from === "guide"
            ? "Claude couldn't read a brand kit out of that. Try a clearer file, or fill it in by hand."
            : "Claude couldn't put a kit together from that. Try saying a bit more, or fill it in by hand.",
      };
    }
    return { draft: draft.kit, draftId: Date.now() };
  } catch (err) {
    console.error(`Brand kit draft failed: ${err instanceof Error ? err.message : "unknown"}`);
    return {
      error: "Claude isn't answering right now. Try again in a minute, or fill it in by hand.",
    };
  }
}

const list = (value: string) =>
  [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((word) => word.trim().slice(0, 40))
        .filter(Boolean),
    ),
  ].slice(0, 15);

/** Saves the kit a person has looked over. */
export async function saveKit(
  slug: string,
  _prev: BrandState,
  formData: FormData,
): Promise<BrandState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };

  const names = formData.getAll("color_name").map(String);
  const hexes = formData.getAll("color_hex").map(String);
  const colors: { name: string; hex: string }[] = [];
  for (const [index, raw] of hexes.entries()) {
    const hex = tidyHex(raw);
    if (!hex)
      return {
        error: `"${raw}" isn't a colour we can read. Use the picker or a code like #1f3d2b.`,
      };
    colors.push({ name: tidyColorName(names[index] ?? "", index), hex });
  }
  if (colors.length < 2) return { error: "A kit needs at least two colours: one dark, one light." };
  if (new Set(colors.map((c) => c.name)).size !== colors.length) {
    return { error: "Give each colour its own name." };
  }

  const parsed = brandKitSchema.safeParse({
    version: 1,
    name: text(formData, "name", 80),
    site: tidySite(text(formData, "site", 120)),
    tagline: text(formData, "tagline", 120),
    about: text(formData, "about", 800),
    look: text(formData, "look", 400),
    voice: text(formData, "voice", 2000),
    words_to_use: list(text(formData, "words_to_use", 800)),
    words_to_avoid: list(text(formData, "words_to_avoid", 800)),
    feel: text(formData, "feel", 20),
    colors,
  });
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "");
    return {
      error:
        field === "name"
          ? "Give your brand a name."
          : field === "site"
            ? "Write your website like yourshop.com."
            : "Something in the kit isn't quite right. Check the fields and try again.",
    };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: BRAND_MODULE,
    p_key: KIT_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: "We couldn't save that. Please try again." };
  revalidatePath(`/w/${slug}`, "layout");
  return { saved: true };
}

/** Saves how the workspace looks to its team: light or dark, and brand colours or not. */
export async function saveAppearance(
  slug: string,
  _prev: BrandState,
  formData: FormData,
): Promise<BrandState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const parsed = appearanceSchema.safeParse({
    version: 1,
    mode: text(formData, "mode", 10),
    brand_colors: formData.get("brand_colors") === "on",
  });
  if (!parsed.success) return { error: "Pick light, dark or match my device." };
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: BRAND_MODULE,
    p_key: APPEARANCE_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: "We couldn't save that. Please try again." };
  revalidatePath(`/w/${slug}`, "layout");
  return { saved: true };
}
