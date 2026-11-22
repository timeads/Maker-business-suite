import type Stripe from "stripe";
import { PLANS, PLAN_ORDER } from "./plans";

/**
 * Creates (or updates) the Stripe products, prices and billing-portal
 * settings this app expects. Safe to run any number of times: it changes
 * nothing when Stripe already matches `plans.ts`.
 */
export async function ensureStripeCatalog(
  stripe: Stripe,
  log: (message: string) => void = console.log,
): Promise<void> {
  const products: { product: string; prices: string[] }[] = [];

  for (const key of PLAN_ORDER) {
    const plan = PLANS[key];
    const productId = `mbs_${key}`;
    const details = {
      name: `Maker Business Suite ${plan.name}`,
      description: plan.tagline,
    };

    let product;
    try {
      product = await stripe.products.update(productId, { ...details, active: true });
    } catch {
      product = await stripe.products.create({ id: productId, ...details });
    }

    const amount = plan.priceMonthly * 100;
    const existing = await stripe.prices.list({ lookup_keys: [plan.lookupKey], limit: 1 });
    let price = existing.data[0];
    const matches =
      price &&
      price.active &&
      price.unit_amount === amount &&
      price.currency === "usd" &&
      price.recurring?.interval === "month" &&
      price.product === product.id;
    if (!matches) {
      // Prices can't be edited: make a new one and move the lookup key to it.
      // Existing subscribers stay on the price they signed up at.
      price = await stripe.prices.create({
        product: product.id,
        currency: "usd",
        unit_amount: amount,
        recurring: { interval: "month" },
        lookup_key: plan.lookupKey,
        transfer_lookup_key: true,
        metadata: { plan: key },
      });
      log(`created price ${price.id} for ${plan.name} ($${plan.priceMonthly}/month)`);
    } else {
      log(`price for ${plan.name} is up to date (${price.id})`);
    }
    products.push({ product: product.id, prices: [price.id] });
  }

  const features = {
    payment_method_update: { enabled: true },
    invoice_history: { enabled: true },
    subscription_cancel: { enabled: true, mode: "at_period_end" as const },
    subscription_update: {
      enabled: true,
      default_allowed_updates: ["price" as const],
      proration_behavior: "create_prorations" as const,
      products,
    },
  };
  const configs = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1 });
  if (configs.data[0]) {
    await stripe.billingPortal.configurations.update(configs.data[0].id, { features });
    log("updated the default billing portal configuration");
  } else {
    await stripe.billingPortal.configurations.create({ features });
    log("created a billing portal configuration");
  }
}
