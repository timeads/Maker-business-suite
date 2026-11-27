import type Anthropic from "@anthropic-ai/sdk";
import { BOOKINGS_TOOL, bookingsSetupItems } from "../bookings/setup";
import { loadBookingsSetupFacts } from "../bookings/setup-data";
import { HELPDESK_TOOL, helpdeskSetupItems } from "../helpdesk/setup";
import { loadHelpdeskSetupFacts } from "../helpdesk/setup-data";
import type { ModuleKey } from "../modules";
import { loadNotNow } from "../setup/data";
import { sortItems, type SetupItem } from "../setup/items";
import { SHIPPING_TOOL, shippingSetupItems } from "../shipping/setup";
import { loadShippingSetupFacts } from "../shipping/setup-data";
import { SOCIAL_TOOL, socialSetupItems } from "../social/setup";
import { loadSocialSetupFacts } from "../social/setup-data";
import { STOCK_TOOL, stockSetupItems } from "../stock/setup";
import { loadStockSetupFacts } from "../stock/setup-data";
import type { ToolContext, ToolOutcome } from "./tools";

/**
 * "What's left to set up" for Stock, Shipping, Bookings, the help desk and
 * Social, mirroring
 * `money_setup_status`: read only, with the member's own session, and
 * offered only to people who have that tool. No write tools: the steps are
 * done on the tool's own pages.
 */

const NO_INPUT = { type: "object" as const, properties: {}, additionalProperties: false };

/** Which of this person's tools each setup tool reads (never sent to the model). */
export const SETUP_TOOL_MODULE: Record<string, ModuleKey> = {
  stock_setup_status: "stock",
  shipping_setup_status: "shipping",
  bookings_setup_status: "bookings",
  helpdesk_setup_status: "helpdesk",
  social_setup_status: "social",
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
  {
    name: "bookings_setup_status",
    description:
      "What's still left to set up in Bookings for this workspace (something to book, dates and open hours, how people pay: Stripe or the shop and its date picker, where customers' replies go, and optional extras like reminder timing, email words, text reminders, Eventbrite, order tags, bringing bookings across and the classroom), each with why it matters, whether it's optional, whether only an owner or admin can do it, and the page (inside the workspace) where it's done. Use it when someone asks how to get started with bookings, why people can't book or pay, or where to change something in Bookings.",
    input_schema: NO_INPUT,
  },
  {
    name: "helpdesk_setup_status",
    description:
      "What's still left to set up in the help desk for this workspace (email arriving through forwarding, Instagram or Facebook switched on but blocked, and optional extras like your own address, the undo wait, saved replies, rules, Instagram and Facebook, the automatic reply, the manual, the help centre and the shop beside each conversation), each with why it matters, whether it's optional, whether only an owner or admin can do it, and the page (inside the workspace) where it's done. Use it when someone asks how to get started with the help desk, why email isn't arriving, or where to change something there. It never writes an automatic reply's words: those are typed by a person on their own page.",
    input_schema: NO_INPUT,
  },
  {
    name: "social_setup_status",
    description:
      "What's still left to set up in Social for this workspace (the brand kit, a Facebook login allowed to post with accounts chosen, accounts that need logging in again, and optional extras like TikTok and LinkedIn, the content plan, the monthly run, post review, the link page and the logo), each with why it matters, whether it's optional, whether only an owner or admin can do it, and the page (inside the workspace) where it's done. Use it when someone asks how to get started with Social, why a post can't go out, or where to change something there. It never switches the monthly run on: a person does that on the plan page.",
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
    if (tool === "shipping") {
      const [facts, notNow] = await Promise.all([
        loadShippingSetupFacts(ctx.supabase, ctx.tenant),
        loadNotNow(ctx.supabase, ctx.tenant.id, SHIPPING_TOOL),
      ]);
      return answer(ctx, shippingSetupItems(facts), notNow, "shipping/setup");
    }
    if (tool === "bookings") {
      const [facts, notNow] = await Promise.all([
        loadBookingsSetupFacts(ctx.supabase, ctx.tenant, {
          manager: ctx.manager,
          can: (feature) => Boolean(ctx.canExtra?.(feature)),
        }),
        loadNotNow(ctx.supabase, ctx.tenant.id, BOOKINGS_TOOL),
      ]);
      return answer(ctx, bookingsSetupItems(facts), notNow, "bookings/setup");
    }
    if (tool === "helpdesk") {
      const [facts, notNow] = await Promise.all([
        loadHelpdeskSetupFacts(ctx.supabase, ctx.tenant),
        loadNotNow(ctx.supabase, ctx.tenant.id, HELPDESK_TOOL),
      ]);
      return answer(ctx, helpdeskSetupItems(facts), notNow, "helpdesk/setup");
    }
    const [facts, notNow] = await Promise.all([
      loadSocialSetupFacts(ctx.supabase, ctx.tenant, { deep: true }),
      loadNotNow(ctx.supabase, ctx.tenant.id, SOCIAL_TOOL),
    ]);
    return answer(ctx, socialSetupItems(facts), notNow, "social/setup");
  } catch {
    return { content: "That couldn't be read just now.", isError: true };
  }
}
