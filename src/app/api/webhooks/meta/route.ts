import { createHash } from "node:crypto";
import { validMetaSignature, webhookChallenge } from "@/lib/helpdesk/social/signature";
import { getAdminClient } from "@/lib/supabase/admin";

/**
 * Meta's webhook: Instagram and Facebook messages for the help desk.
 *
 * GET is Meta checking the address when it is entered in the app dashboard:
 * the challenge is echoed only for the verify token this deployment was
 * given. POST is a delivery: its signature is checked against the app secret
 * on the bytes exactly as they arrived, then it is queued for the worker and
 * answered at once (Meta allows five seconds). Nothing is filed here.
 */
const MAX_BODY = 1_000_000;

export async function GET(request: Request) {
  const challenge = webhookChallenge(
    new URL(request.url).searchParams,
    process.env.META_WEBHOOK_VERIFY_TOKEN,
  );
  if (challenge === null) return new Response("Not allowed", { status: 403 });
  return new Response(challenge, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function POST(request: Request) {
  const secret = process.env.META_APP_SECRET;
  if (!secret || !process.env.SUPABASE_SECRET_KEY) {
    return Response.json({ error: "Messages are not configured" }, { status: 503 });
  }
  // The raw bytes: Meta signs its own escaped form, which re-encoding would change.
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > MAX_BODY) return Response.json({ error: "Too big" }, { status: 413 });
  if (!validMetaSignature(raw, request.headers.get("x-hub-signature-256"), secret)) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  let payload: { object?: unknown; entry?: unknown };
  try {
    payload = JSON.parse(raw.toString("utf8")) as typeof payload;
  } catch {
    return Response.json({ error: "Malformed delivery" }, { status: 400 });
  }
  // Signed, but nothing we file (another product's webhook on the same app): thank Meta and move on.
  if (
    (payload?.object !== "page" && payload?.object !== "instagram") ||
    !Array.isArray(payload.entry)
  ) {
    return Response.json({ received: true });
  }

  // The same delivery twice (Meta retries) is kept once. A delivery for an
  // account no workspace has connected for messages is dropped by the database.
  const { error } = await getAdminClient().rpc("enqueue_meta_event", {
    p_id: createHash("sha256").update(raw).digest("hex"),
    p_payload: payload,
  });
  if (error) {
    // A 5xx makes Meta try again.
    console.error(`Could not queue a Meta delivery: ${error.message}`);
    return Response.json({ error: "Could not queue delivery" }, { status: 500 });
  }
  return Response.json({ received: true });
}
