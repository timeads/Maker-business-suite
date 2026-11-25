"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import {
  MICHAELS_MODULE,
  MICHAELS_SETTINGS_KEY,
  michaelsSettingsSchema,
} from "@/lib/michaels/config";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type MichaelsState = { error?: string; message?: string };

const NO_ACCESS = "Michaels isn't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can do that.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't save. Please try again.";

/** Everything here changes pairings or settings, so everything here is for owners and admins. */
async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/stock/michaels`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("michaels")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  if (!canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  return { tenant: ctx.tenant, supabase: await createClient() } as const;
}

const done = (slug: string) => {
  revalidatePath(`/w/${slug}/stock/michaels`, "layout");
  // This tool's settings screens live under workspace Settings.
  revalidatePath(`/w/${slug}/settings`, "layout");
};

/**
 * Saves the connector's switches. The mode is not read from the form: this
 * stage only watches, and the schema has no other mode to save.
 */
export async function saveMichaelsSettings(
  slug: string,
  _prev: MichaelsState,
  formData: FormData,
): Promise<MichaelsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const held = String(formData.get("units_held_back") ?? "").trim();
  const parsed = michaelsSettingsSchema.safeParse({
    version: 1,
    enabled: formData.get("enabled") === "on",
    mode: "watch",
    units_held_back: /^\d{1,4}$/.test(held) ? Number.parseInt(held, 10) : Number.NaN,
    jobs: {
      stock: formData.get("job_stock") === "on",
      prices: formData.get("job_prices") === "on",
      orders: formData.get("job_orders") === "on",
    },
  });
  if (!parsed.success) {
    return { error: "Units held back is a whole number from 0 to 1,000." };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: MICHAELS_MODULE,
    p_key: MICHAELS_SETTINGS_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  done(slug);
  return {
    message: parsed.data.enabled
      ? "Saved. We'll look at Michaels about once an hour."
      : "Saved. Michaels is switched off, so nothing is being read.",
  };
}

/** Pairs a Michaels seller SKU with the item in the shop that has the typed SKU. */
export async function pairListing(
  slug: string,
  sellerSku: string,
  _prev: MichaelsState,
  formData: FormData,
): Promise<MichaelsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const shopSku = String(formData.get("shop_sku") ?? "");
  if (!shopSku.trim()) return { error: "Type the SKU of the item in your shop." };
  if (!sellerSku || sellerSku.length > 200 || shopSku.length > 200) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("set_michaels_pairing", {
    p_tenant_id: ctx.tenant.id,
    p_seller_sku: sellerSku,
    p_shop_sku: shopSku,
  });
  if (error) {
    const said = error.message ?? "";
    return {
      error: said.includes("many_items")
        ? "More than one item in your shop has that SKU, so we can't tell which you mean. Give them different SKUs in your shop first."
        : said.includes("no_item")
          ? "Nothing in your shop has that SKU. Check it against the Everything tab."
          : said.includes("no_listing")
            ? "That listing is no longer on Michaels."
            : OOPS,
    };
  }
  done(slug);
  return { message: "Paired." };
}

/** Takes a hand pairing off; the next look matches the listing by the usual rules. */
export async function unpairListing(
  slug: string,
  sellerSku: string,
  _prev: MichaelsState,
): Promise<MichaelsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!sellerSku || sellerSku.length > 200) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("remove_michaels_pairing", {
    p_tenant_id: ctx.tenant.id,
    p_seller_sku: sellerSku,
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Pairing taken off." };
}

/** Asks the worker to look at Michaels at its next turn. Reads only, like every look. */
export async function lookNow(slug: string, _prev: MichaelsState): Promise<MichaelsState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("request_michaels_run", {
    p_tenant_id: ctx.tenant.id,
  });
  if (error) {
    const said = error.message ?? "";
    return {
      error: said.includes("too_soon")
        ? "We looked a few minutes ago. Try again in ten minutes."
        : said.includes("not_on")
          ? "Connect Michaels and switch it on under Settings → Stock → Michaels first."
          : "We couldn't start a look. Try again in a moment.",
    };
  }
  done(slug);
  return { message: "Looking now. This page updates when it's done, usually within a minute." };
}
