import { randomBytes } from "node:crypto";
import { parseSignedRequest } from "@/lib/helpdesk/social/signature";
import { getSiteUrl } from "@/lib/site-url";
import { getAdminClient } from "@/lib/supabase/admin";

/**
 * Meta's data deletion callback (App Dashboard → Settings → "Data deletion
 * request URL"). Meta posts a signed request naming a person by id; the
 * signature is checked with the app secret, the deletion is queued for the
 * worker, and Meta is given a code and a link where the person can see how
 * it stands. Whatever the help desk holds under that id, in any workspace,
 * is then deleted: the person, their conversations, messages and files.
 */
export async function POST(request: Request) {
  const secret = process.env.META_APP_SECRET;
  if (!secret || !process.env.SUPABASE_SECRET_KEY) {
    return Response.json({ error: "Not configured" }, { status: 503 });
  }
  let signed: unknown = null;
  try {
    signed = (await request.formData()).get("signed_request");
  } catch {
    signed = null;
  }
  const parsed = parseSignedRequest(signed, secret);
  if (!parsed) return Response.json({ error: "Not authorized" }, { status: 401 });

  const code = randomBytes(12).toString("hex");
  const { error } = await getAdminClient().rpc("request_meta_deletion", {
    p_code: code,
    p_external_id: parsed.userId,
  });
  if (error) {
    console.error(`Could not queue a deletion request: ${error.message}`);
    return Response.json({ error: "Could not queue the request" }, { status: 500 });
  }
  const site = await getSiteUrl();
  return Response.json({
    url: `${site}/api/webhooks/meta/deletion?code=${code}`,
    confirmation_code: code,
  });
}

/** Where Meta sends the person: how their request stands, in plain words. Says nothing about anyone. */
export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code") ?? "";
  let status: string | null = null;
  if (/^[a-z0-9]{16,40}$/.test(code) && process.env.SUPABASE_SECRET_KEY) {
    const { data } = await getAdminClient().rpc("meta_deletion_status", { p_code: code });
    status = typeof data === "string" ? data : null;
  }
  const words =
    status === "done"
      ? "Your request has been carried out. Anything our help desk held about you from Instagram or Facebook messages has been deleted."
      : status === "received"
        ? "We have your request and are deleting what our help desk holds about you from Instagram or Facebook messages. It is usually done within a few minutes."
        : "We couldn't find a request with that code.";
  return new Response(`${words}\n`, {
    status: status ? 200 : 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}
