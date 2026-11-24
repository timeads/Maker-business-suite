"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { PLANS, TRIAL_DAYS, isPlanKey } from "@/lib/billing/plans";
import { getSubscriptionRow } from "@/lib/billing/store";
import { billingConfigured, getStripe } from "@/lib/billing/stripe";
import { getEntitlements } from "@/lib/entitlements";
import { MODULES } from "@/lib/modules";
import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type BillingState = { error?: string };

const NOT_ALLOWED = "Only owners and admins can change the plan.";
const NOT_READY = "Billing isn't switched on for this environment yet.";
const FAILED = "We couldn't reach our payment provider. Try again in a moment.";

async function billingContext(slug: string) {
  const user = await requireUser(`/w/${slug}/settings/billing`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) return null;
  return { user, ...ctx };
}

const LIVE = ["trialing", "active", "past_due", "unpaid", "paused"];

/** Sends the owner to Stripe Checkout for the chosen plan. */
export async function startCheckout(
  slug: string,
  _prev: BillingState,
  formData: FormData,
): Promise<BillingState> {
  const ctx = await billingContext(slug);
  if (!ctx) return { error: NOT_ALLOWED };
  if (!billingConfigured()) return { error: NOT_READY };
  const planKey = formData.get("plan");
  if (!isPlanKey(planKey)) return { error: "Pick a plan to continue." };
  if ((await getEntitlements(ctx.tenant.id)).internal) {
    return {
      error: "This workspace is on an internal plan, set up by us. There's nothing to pay.",
    };
  }

  let url: string | null = null;
  try {
    const stripe = getStripe();
    const existing = await getSubscriptionRow(ctx.tenant.id);
    if (existing && LIVE.includes(existing.status)) {
      // Already subscribed: plan changes happen in the billing portal.
      return { error: "This workspace already has a plan. Use Manage billing to change it." };
    }

    const prices = await stripe.prices.list({
      lookup_keys: [PLANS[planKey].lookupKey],
      active: true,
      limit: 1,
    });
    const price = prices.data[0];
    if (!price) return { error: NOT_READY };

    const site = await getSiteUrl();
    const back = `${site}/w/${slug}/settings/billing`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: price.id, quantity: 1 }],
      client_reference_id: ctx.tenant.id,
      metadata: { tenant_id: ctx.tenant.id },
      subscription_data: {
        metadata: { tenant_id: ctx.tenant.id },
        // One trial per workspace: coming back after cancelling starts paid.
        ...(existing ? {} : { trial_period_days: TRIAL_DAYS }),
      },
      ...(existing
        ? { customer: existing.stripe_customer_id }
        : { customer_email: ctx.user.email }),
      success_url: `${back}?checkout=success`,
      cancel_url: back,
    });
    url = session.url;
  } catch (err) {
    console.error("Checkout failed", err instanceof Error ? err.message : err);
    return { error: FAILED };
  }
  if (!url) return { error: FAILED };
  redirect(url);
}

/** Sends the owner to the Stripe Customer Portal: card, invoices, plan changes, cancel. */
export async function openBillingPortal(slug: string, _prev: BillingState): Promise<BillingState> {
  const ctx = await billingContext(slug);
  if (!ctx) return { error: NOT_ALLOWED };
  if (!billingConfigured()) return { error: NOT_READY };

  let url: string | null = null;
  try {
    const existing = await getSubscriptionRow(ctx.tenant.id);
    if (!existing) return { error: "Pick a plan first." };
    const site = await getSiteUrl();
    const session = await getStripe().billingPortal.sessions.create({
      customer: existing.stripe_customer_id,
      return_url: `${site}/w/${slug}/settings/billing`,
    });
    url = session.url;
  } catch (err) {
    console.error("Portal failed", err instanceof Error ? err.message : err);
    return { error: FAILED };
  }
  redirect(url);
}

/** On plans with a choice of tools (Starter), picks which one is switched on. */
export async function chooseModule(
  slug: string,
  _prev: BillingState,
  formData: FormData,
): Promise<BillingState> {
  const ctx = await billingContext(slug);
  if (!ctx) return { error: NOT_ALLOWED };
  const entitlements = await getEntitlements(ctx.tenant.id);
  const plan = entitlements.plan;
  if (!plan || plan.moduleChoices < 1)
    return { error: "Your plan doesn't include a choice of tools." };

  const picked = formData.getAll("module").map(String);
  const allowed = MODULES.filter((m) => !plan.includedModules.includes(m.key)).map((m) => m.key);
  if (picked.length > plan.moduleChoices || picked.some((key) => !allowed.includes(key as never))) {
    return {
      error: `Pick ${plan.moduleChoices === 1 ? "one tool" : `up to ${plan.moduleChoices} tools`}.`,
    };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("choose_modules", {
    p_tenant_id: ctx.tenant.id,
    p_modules: picked,
  });
  if (error) return { error: "We couldn't save that choice. Try again in a moment." };
  revalidatePath(`/w/${slug}`, "layout");
  return {};
}
