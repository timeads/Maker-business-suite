import Stripe from "stripe";

let client: Stripe | null = null;

/** True once the Stripe secret key is set for this environment. */
export function billingConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing environment variable STRIPE_SECRET_KEY. See .env.example.");
  client ??= new Stripe(key);
  return client;
}
