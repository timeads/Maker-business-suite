import type Anthropic from "@anthropic-ai/sdk";
import type { ModuleKey } from "../modules";
import { loadNotNow } from "../setup/data";
import { sortItems, type SetupItem } from "../setup/items";
import { SHIPPING_TOOL, shippingSetupItems } from "../shipping/setup";
import { loadShippingSetupFacts } from "../shipping/setup-data";
import { STOCK_TOOL, stockSetupItems } from "../stock/setup";
import { loadStockSetupFacts } from "../stock/setup-data";
import type { ToolContext, ToolOutcome } from "./tools";

/**
 * "What's left to set up" for Stock and Shipping, mirroring
 * `money_setup_status`: read only, with the member's own session, and
 * offered only to people who have that tool. No write tools: the steps are
 * done on the tool's own pages.
 */

const NO_INPUT = { type: "object" as const, properties: {}, additionalProperties: false };

/** Which of this person's tools each setup tool reads (never sent to the model). */
export const SETUP_TOOL_MODULE: Record<string, ModuleKey> = {
  stock_setup_status: "stock",
  shipping_setup_status: "shipping",
};

export const SETUP_TOOLS: Anthropic.Tool[] = [
  {
    name: "stock_setup_status",
    description:
      "What's still left to set up in Stock for this workspace (suppliers, delivery days, planning figures, costs, and optional extras), each with why it matters, whether it's optional, whether only an owner or admin can do it, and the page (inside the workspace) where it's done. Use it when someone asks what to fine-tune, why an order-by date or suggestion looks off, or where to change something in Stock.",
    input_schema: NO_INPUT,
  },
  {
    name: "shipping_setup_status",
    description:
      "What's still left to set up in Shipping for this workspace (the shop's addresses, the ship-from address, boxes, postage accounts, weights, and optional extras like the slip and rules), each with why it matters, whether it's optional, whether only an owner or admin can do it, and the page (inside the workspace) where it's done. Use it when someone asks what to fine-tune, why an order can't be priced, or where to change something in Shipping.",
    input_schema: NO_INPUT,
  },
];

const json = (value: unknown) => JSON.stringify(value);

function answer(
  ctx: ToolContext,
  items: SetupItem[],
  notNow: Parameters<typeof sortItems>[1],
  guided: string,
) {
  const { open, resting } = sortItems(items, notNow);
  const slug = ctx.tenant.slug ?? "<workspace>";
  return {
    content: json({
      open: open.map((item) => ({
        what: item.title,
        why: item.why,
        optional: Boolean(item.optional),
        owners_and_admins_only: Boolean(item.managersOnly),
        where: `/w/${slug}/${item.to}`,
        link_words: item.action,
      })),
      said_not_now: resting.map((item) => item.title),
      guided_setup: `/w/${slug}/${guided}`,
      note:
        open.length === 0
          ? "Nothing left to set up."
          : ctx.manager
            ? undefined
            : "This person isn't an owner or admin: for items marked owners_and_admins_only, suggest they ask one.",
    }),
  };
}

/** Runs one of the setup tools, or returns null when `name` isn't one. */
export async function runSetupTool(name: string, ctx: ToolContext): Promise<ToolOutcome | null> {
  const tool = SETUP_TOOL_MODULE[name];
  if (!tool) return null;
  if (!ctx.can(tool)) {
    return { content: `There is no tool called ${name}.`, isError: true };
  }
  try {
    if (tool === "stock") {
      const [facts, notNow] = await Promise.all([
        loadStockSetupFacts(ctx.supabase, ctx.tenant, {
          manager: ctx.manager,
          seesCosts: Boolean(ctx.seesCosts),
        }),
        loadNotNow(ctx.supabase, ctx.tenant.id, STOCK_TOOL),
      ]);
      return answer(ctx, stockSetupItems(facts), notNow, "stock/setup");
    }
    const [facts, notNow] = await Promise.all([
      loadShippingSetupFacts(ctx.supabase, ctx.tenant),
      loadNotNow(ctx.supabase, ctx.tenant.id, SHIPPING_TOOL),
    ]);
    return answer(ctx, shippingSetupItems(facts), notNow, "shipping/setup");
  } catch {
    return { content: "That couldn't be read just now.", isError: true };
  }
}
