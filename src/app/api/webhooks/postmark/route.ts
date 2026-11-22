import { timingSafeEqual } from "node:crypto";
import { getAdminClient } from "@/lib/supabase/admin";

/**
 * Postmark inbound email webhook. Postmark doesn't sign these, so the webhook
 * URL carries a username and secret (https://postmark:SECRET@host/...), which
 * arrive as HTTP Basic auth. The email is queued for the worker and answered
 * quickly.
 */
export async function POST(request: Request) {
  const secret = process.env.POSTMARK_INBOUND_SECRET;
  if (!secret || !process.env.SUPABASE_SECRET_KEY) {
    return Response.json({ error: "Inbound email is not configured" }, { status: 503 });
  }

  const expected = Buffer.from(`Basic ${Buffer.from(`postmark:${secret}`).toString("base64")}`);
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  let payload: { MessageID?: unknown };
  try {
    payload = (await request.json()) as { MessageID?: unknown };
  } catch {
    return Response.json({ error: "Malformed email" }, { status: 400 });
  }
  if (typeof payload.MessageID !== "string" || !payload.MessageID) {
    return Response.json({ error: "Malformed email" }, { status: 400 });
  }

  const { error } = await getAdminClient().rpc("enqueue_inbound_email", {
    p_id: payload.MessageID,
    p_payload: payload,
  });
  if (error) {
    // A 5xx makes Postmark retry.
    console.error(`Could not queue inbound email ${payload.MessageID}: ${error.message}`);
    return Response.json({ error: "Could not queue email" }, { status: 500 });
  }
  return Response.json({ received: true });
}
