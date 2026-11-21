import { billingConfigured, getStripe } from "@/lib/billing/stripe";
import { getAdminClient } from "@/lib/supabase/admin";

/**
 * Stripe webhook. Does the minimum inline: verify the signature on the raw
 * body, put the event on the queue, answer. The worker applies it.
 */
export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !billingConfigured()) {
    return Response.json({ error: "Billing is not configured" }, { status: 503 });
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

  const { error } = await getAdminClient().rpc("enqueue_stripe_event", {
    p_id: event.id,
    p_type: event.type,
    p_payload: event,
  });
  if (error) {
    // A 5xx makes Stripe retry, which is what we want if the queue is down.
    console.error(`Could not queue Stripe event ${event.id}: ${error.message}`);
    return Response.json({ error: "Could not queue event" }, { status: 500 });
  }
  return Response.json({ received: true });
}
