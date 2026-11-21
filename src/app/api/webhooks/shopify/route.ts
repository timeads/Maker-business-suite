import { verifyShopifyWebhookHmac } from "@/lib/connections/providers/shopify";
import { getAdminClient } from "@/lib/supabase/admin";

/**
 * Shopify webhooks, including the three privacy ones every public app must
 * accept. Verifies the signature on the raw body, queues the delivery for
 * the worker, and answers quickly.
 */
export async function POST(request: Request) {
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret || !process.env.SUPABASE_SECRET_KEY) {
    return Response.json({ error: "Shopify is not configured" }, { status: 503 });
  }

  const body = await request.text();
  if (!verifyShopifyWebhookHmac(body, request.headers.get("x-shopify-hmac-sha256"), secret)) {
    // Shopify's review checks that a bad signature gets a 401.
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  const topic = request.headers.get("x-shopify-topic");
  const shop = request.headers.get("x-shopify-shop-domain");
  const deliveryId = request.headers.get("x-shopify-webhook-id");
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = null;
  }
  if (!topic || !shop || !deliveryId || payload === null) {
    return Response.json({ error: "Malformed webhook" }, { status: 400 });
  }

  const { data, error } = await getAdminClient().rpc("enqueue_provider_webhook", {
    p_provider: "shopify",
    p_external_account_id: shop.toLowerCase(),
    p_topic: topic,
    p_dedupe_key: deliveryId,
    p_payload: payload,
  });
  if (error) {
    console.error(`Could not queue Shopify webhook ${deliveryId}: ${error.message}`);
    return Response.json({ error: "Could not queue webhook" }, { status: 500 });
  }
  // "unknown_account" is still a 200: we hold nothing for that store, which
  // is also the right answer to a privacy request about it.
  return Response.json({ received: true, result: data });
}
