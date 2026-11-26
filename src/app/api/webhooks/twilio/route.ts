import { getSiteUrl } from "@/lib/site-url";
import { getAdminClient } from "@/lib/supabase/admin";
import { getTwilioAccess } from "@/lib/texts/access";
import { isStopWord } from "@/lib/texts/opt-out";
import { toE164 } from "@/lib/texts/phone";
import { validTwilioSignature } from "@/lib/texts/signature";
import { ACCOUNT_SID } from "@/lib/texts/twilio-client";

/**
 * Twilio's webhook for texts that come back to a workspace's number. Each
 * request is checked against the `X-Twilio-Signature` Twilio puts on it,
 * worked out with that workspace's own auth token (read from Vault, never an
 * environment variable), before anything in it is trusted: 401 when it
 * doesn't match. A STOP is queued for the worker, once per Twilio message
 * id, and answered at once; nothing else is kept, and no reply is sent from
 * here (Twilio sends its own to a STOP).
 *
 * The address to give Twilio is `<site>/api/webhooks/twilio`
 * (docs/text-reminders.md).
 */
const MAX_BODY = 64_000;
const EMPTY_REPLY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const MESSAGE_SID = /^(SM|MM)[0-9a-f]{32}$/;

const reply = () =>
  new Response(EMPTY_REPLY, { headers: { "content-type": "text/xml; charset=utf-8" } });
const refuse = () => Response.json({ error: "Not authorized" }, { status: 401 });

export async function POST(request: Request) {
  if (!process.env.SUPABASE_SECRET_KEY) {
    return Response.json({ error: "Texts are not configured" }, { status: 503 });
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY) return Response.json({ error: "Too big" }, { status: 413 });
  const signature = request.headers.get("x-twilio-signature");
  if (!signature) return refuse();
  const params = new URLSearchParams(raw);

  // Which workspace's token to check with: the account Twilio says it is for.
  // Nothing else in the request is believed until the signature matches.
  const accountSid = params.get("AccountSid") ?? "";
  if (!ACCOUNT_SID.test(accountSid)) return refuse();
  const admin = getAdminClient();
  const { data: tenantId, error } = await admin.rpc("twilio_workspace_for", {
    p_account_sid: accountSid,
  });
  if (error) {
    console.error(`Could not look up a Twilio account: ${error.message}`);
    return Response.json({ error: "Try again" }, { status: 500 });
  }
  if (typeof tenantId !== "string") return refuse();
  let authToken: string;
  try {
    authToken = (await getTwilioAccess(tenantId)).authToken;
  } catch {
    return refuse();
  }
  // The address exactly as Twilio was given it, query and all.
  const url = `${await getSiteUrl()}/api/webhooks/twilio${new URL(request.url).search}`;
  if (!validTwilioSignature(authToken, url, params, signature)) return refuse();

  // Signed. Only a STOP from a number we can read is kept.
  const messageSid = params.get("MessageSid") ?? params.get("SmsSid") ?? "";
  const from = toE164(params.get("From") ?? "", null);
  if (!isStopWord(params.get("Body")) || !from || !MESSAGE_SID.test(messageSid)) return reply();

  const { error: queueError } = await admin.rpc("enqueue_twilio_inbound", {
    p_tenant_id: tenantId,
    p_message_sid: messageSid,
    p_from: from,
    p_to: params.get("To") ?? "",
  });
  if (queueError) {
    // A 5xx makes Twilio try again; the same message is kept once.
    console.error(`Could not queue a text reply: ${queueError.message}`);
    return Response.json({ error: "Could not queue" }, { status: 500 });
  }
  return reply();
}
