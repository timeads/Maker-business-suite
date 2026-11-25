import { NextResponse } from "next/server";
import { getEntitlements } from "@/lib/entitlements";
import { FILES_BUCKET, fileHeaders, isVideo } from "@/lib/helpdesk/files";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * A picture or file from a help desk conversation. The row is read as the
 * signed-in member, so row-level security decides whether it is theirs to
 * see; anyone else gets "Not found", the same answer as for a file that
 * doesn't exist. Only then is the file fetched from the private bucket with
 * the server's own access and handed over with headers of our choosing: the
 * type we worked out from its bytes, no guessing, nothing it may load or
 * run, never cached by anything shared. `?download=1` always downloads.
 *
 * A video is the one exception to streaming: browsers ask for a video in
 * parts, so it is sent on to a storage link that lasts a minute.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const missing = () =>
    new NextResponse("Not found", {
      status: 404,
      headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return missing();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return missing();
  const { data } = await supabase
    .from("message_attachments")
    .select("tenant_id, name, mime_type, bytes, storage_path, state")
    .eq("id", id)
    .maybeSingle();
  const file = data as {
    tenant_id: string;
    name: string;
    mime_type: string;
    bytes: number;
    storage_path: string | null;
    state: string;
  } | null;
  if (!file || file.state !== "kept" || !file.storage_path) return missing();
  // The path was written by the server under the workspace's own id; check it anyway.
  if (!file.storage_path.startsWith(`${file.tenant_id}/`)) return missing();
  if (!(await getEntitlements(file.tenant_id)).can("module.helpdesk")) return missing();
  if (!process.env.SUPABASE_SECRET_KEY) return missing();

  const download = new URL(request.url).searchParams.get("download") === "1";
  const bucket = getAdminClient().storage.from(FILES_BUCKET);
  if (isVideo(file.mime_type) && !download) {
    const { data: signed } = await bucket.createSignedUrl(file.storage_path, 60);
    if (!signed?.signedUrl) return missing();
    return NextResponse.redirect(signed.signedUrl, {
      status: 302,
      headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" },
    });
  }
  const { data: blob, error } = await bucket.download(file.storage_path);
  if (error || !blob) return missing();
  return new NextResponse(blob.stream(), {
    headers: fileHeaders({ ...file, bytes: blob.size }, { download }),
  });
}
