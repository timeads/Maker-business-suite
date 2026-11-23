"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { MAX_TOGETHER, groupHref, groupName } from "@/lib/shipping/merge";
import { todayIn } from "@/lib/shipping/queue";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import { loadGroup } from "./data";

/**
 * Ship together: what a person decides about orders going to one place.
 * None of this spends anything. Buying the label checks every order again,
 * in the database, under a lock.
 */
export type TogetherState = {
  error?: string;
  message?: string;
  /** Where the orders open as one. */
  href?: string;
  /** The addresses read differently: where each order says it is going, for a person to judge. */
  mismatch?: { name: string; address: string }[];
};

const NO_ACCESS = "Shipping isn't part of this workspace's plan right now.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't save. Please try again.";
const UUID = /^[0-9a-f-]{36}$/i;

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/shipping`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.shipping")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  return { tenant: ctx.tenant, supabase: await createClient() } as const;
}

const pick = (ids: unknown) =>
  [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((id) => String(id).toLowerCase())
        .filter((id) => UUID.test(id)),
    ),
  ].slice(0, MAX_TOGETHER + 1);
const done = (slug: string) => revalidatePath(`/w/${slug}/shipping`, "layout");

async function decide(
  slug: string,
  ids: unknown,
  action: "save" | "dismiss" | "approve" | "separate",
) {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error } as const;
  const orderIds = pick(ids);
  const { error } = await ctx.supabase.rpc("set_shipping_group", {
    p_tenant_id: ctx.tenant.id,
    p_order_ids: orderIds,
    p_action: action,
  });
  if (error) {
    return {
      error: error.message.includes("two to ten")
        ? `Pick two to ${MAX_TOGETHER} orders to ship together.`
        : OOPS,
    } as const;
  }
  done(slug);
  return { ctx, orderIds } as const;
}

/** Checks the orders and says where they open as one, or shows why they can't. */
async function open(slug: string, ids: unknown): Promise<TogetherState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const group = await loadGroup(
    ctx.supabase,
    ctx.tenant.id,
    pick(ids),
    todayIn(ctx.tenant.timezone, new Date()),
  );
  if (!group.check.ok) {
    return group.check.reason === "mismatch"
      ? { mismatch: group.check.addresses }
      : { error: group.check.message };
  }
  return {
    href: groupHref(
      `/w/${slug}/shipping`,
      group.orders.map((order) => order.id),
    ),
  };
}

/**
 * "Ship together": opens the orders as one, oldest first. When their
 * addresses don't read the same, comes back with both for the person to
 * look at instead.
 */
export async function shipTogether(slug: string, ids: string[]): Promise<TogetherState> {
  return open(slug, ids);
}

/** "Yes, these are the same place": remembered for this exact set of orders, then opened. */
export async function approveTogether(slug: string, ids: string[]): Promise<TogetherState> {
  const decided = await decide(slug, ids, "approve");
  if ("error" in decided) return { error: decided.error };
  return open(slug, decided.orderIds);
}

/** "Not now": the suggestion stays away until another order joins that address. */
export async function notNowTogether(slug: string, ids: string[]): Promise<TogetherState> {
  const decided = await decide(slug, ids, "dismiss");
  return "error" in decided ? { error: decided.error } : {};
}

/** "Save for later": the group waits at the top of the queue for whoever buys the label. */
export async function saveTogether(slug: string, ids: string[]): Promise<TogetherState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  // Only a group that could go right now is worth keeping.
  const group = await loadGroup(
    ctx.supabase,
    ctx.tenant.id,
    pick(ids),
    todayIn(ctx.tenant.timezone, new Date()),
  );
  if (!group.check.ok) return { error: group.check.message };
  const decided = await decide(slug, ids, "save");
  if ("error" in decided) return { error: decided.error };
  return {
    message: `Saved. ${groupName(group.orders)} wait together at the top of your to-ship list.`,
  };
}

/** "Separate": each order goes back to being its own. */
export async function separateTogether(slug: string, ids: string[]): Promise<TogetherState> {
  const decided = await decide(slug, ids, "separate");
  return "error" in decided ? { error: decided.error } : {};
}
