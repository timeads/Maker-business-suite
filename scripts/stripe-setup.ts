/**
 * Creates (or updates) the Stripe products, prices and billing-portal settings
 * this app expects. Safe to run more than once.
 *
 *   STRIPE_SECRET_KEY=sk_test_... pnpm stripe:setup
 *
 * The worker also does this each time it starts, so running it by hand is
 * only needed where there is no worker.
 */
import { ensureStripeCatalog } from "../src/lib/billing/setup";
import { getStripe } from "../src/lib/billing/stripe";

async function main() {
  await ensureStripeCatalog(getStripe());
  console.log("\nDone. Next: add a webhook endpoint in Stripe pointing at");
  console.log("  <your site>/api/webhooks/stripe");
  console.log("listening for checkout.session.completed and customer.subscription.* events,");
  console.log("and put its signing secret in STRIPE_WEBHOOK_SECRET.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
