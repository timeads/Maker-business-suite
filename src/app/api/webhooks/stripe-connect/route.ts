import { billingConfigured, getStripe } from "@/lib/billing/stripe";
import { getAdminClient } from "@/lib/supabase/admin";

/**
 * Webhook for events on businesses' own Stripe accounts (booking payments).
 * Same shape as the billing webhook: verify the signature on the raw body,
 * queue, answer. The worker does the rest.
 */
export async function POST(request: Request) {
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret || !billingConfigured()) {
    return Response.json({ error: "Booking payments are not configured" }, { status: 503 });
  }
  const signature = request.headers.get("stripe-signature");
  const body = await request.text();
  if (!signature) {
    return Response.json({ error: "Missing signature" }, { status: 400 });
  }

  let event;
  try {
    event = await getStripe().webhooks.constructEventAsync(body, signature, secret);
  } catch {
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }
  // Only events from a connected account belong here.
  if (!event.account) return Response.json({ received: true });

  const admin = getAdminClient();
  const { error } =
    // Changes to the account itself go to the connection's own queue.
    event.type === "account.application.deauthorized" || event.type === "account.updated"
      ? await admin.rpc("enqueue_provider_webhook", {
          p_provider: "stripe",
          p_external_account_id: event.account,
          p_topic: event.type,
          p_dedupe_key: event.id,
          p_payload: { id: event.id },
        })
      : await admin.rpc("enqueue_stripe_event", {
          p_id: event.id,
          p_type: event.type,
          p_payload: event,
        });
  if (error) {
    console.error(`Could not queue Stripe event ${event.id}: ${error.message}`);
    return Response.json({ error: "Could not queue event" }, { status: 500 });
  }
  return Response.json({ received: true });
}
