import { hookTokenHash, isHookToken } from "@/lib/eventbrite/hook";
import { parseWebhookBody } from "@/lib/eventbrite/orders";
import { getAdminClient } from "@/lib/supabase/admin";

/**
 * Eventbrite's order webhook. Eventbrite doesn't sign its webhooks (there is
 * no signature header to check), so each workspace's address carries a
 * secret of its own, `<site>/api/webhooks/eventbrite/<secret>`, given to
 * Eventbrite once when a manager switched order updates on; only its hash is
 * kept, and the database finds the workspace by it (401 when nothing
 * matches). Even then the body is only a nudge: the order's number is taken
 * from it and queued, and the worker reads the order itself from
 * Eventbrite's API. Nothing the body says about the order is believed.
 */
const MAX_BODY = 16_000;

const refuse = () => Response.json({ error: "Not authorized" }, { status: 401 });

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!process.env.SUPABASE_SECRET_KEY) {
    return Response.json({ error: "Eventbrite is not configured" }, { status: 503 });
  }
  const { token } = await params;
  if (!isHookToken(token)) return refuse();
  const raw = await request.text();
  if (raw.length > MAX_BODY) return Response.json({ error: "Too big" }, { status: 413 });
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    return Response.json({ error: "Malformed" }, { status: 400 });
  }
  const hook = parseWebhookBody(body);
  if (!hook) return Response.json({ error: "Malformed" }, { status: 400 });
  // Only orders change places. Anything else (Eventbrite's test call when the
  // webhook is made, say) is answered so it isn't sent again.
  if (!hook.action.startsWith("order.")) return Response.json({ ignored: true });
  if (!hook.orderId) return Response.json({ error: "Not an order" }, { status: 400 });

  const { data, error } = await getAdminClient().rpc("enqueue_eventbrite_event", {
    p_token_hash: hookTokenHash(token),
    p_order_id: hook.orderId,
    p_refunded: hook.action === "order.refunded",
    p_webhook_id: hook.webhookId,
  });
  if (error) {
    // A 5xx makes Eventbrite try again; the same order is read once.
    console.error(`Could not queue an Eventbrite order: ${error.message}`);
    return Response.json({ error: "Could not queue" }, { status: 500 });
  }
  if (data !== "queued") return refuse();
  return Response.json({ received: true });
}
