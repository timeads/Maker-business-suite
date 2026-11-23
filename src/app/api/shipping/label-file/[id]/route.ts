import { NextResponse } from "next/server";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";

const TYPES: Record<string, string> = {
  "image/gif": "gif",
  "image/png": "png",
  "application/pdf": "pdf",
  "text/plain": "zpl",
};

/**
 * A bought label's own file, for the sources that hand one back instead of a
 * link (UPS, Redo). Read as the signed-in member, so row-level security
 * decides whether it is theirs to see; anyone else gets "Not found".
 *
 * A UPS label is a picture lying on its side, so by default it is shown on a
 * page that stands it up at 4 × 6 inches, ready to print. `?raw=1` is the
 * file itself.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const missing = () => new NextResponse("Not found", { status: 404 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return missing();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return missing();
  const { data } = await supabase
    .from("shipping_label_files")
    .select("tenant_id, content_type, data, box")
    .eq("id", id)
    .maybeSingle();
  const file = data as {
    tenant_id: string;
    content_type: string;
    data: string;
    box: number;
  } | null;
  if (!file || !TYPES[file.content_type]) return missing();
  if (!(await getEntitlements(file.tenant_id)).can("module.shipping")) return missing();

  const safe = {
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  const raw = new URL(request.url).searchParams.get("raw") === "1";
  if (file.content_type === "image/gif" && !raw) {
    // Nothing from the label goes into this page but its own address.
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Label</title><style>
@page { size: 4in 6in; margin: 0 }
html, body { margin: 0; padding: 0; background: #fff }
.label { width: 4in; height: 6in; position: relative; overflow: hidden }
.label img { position: absolute; top: 0; left: 4in; width: 6in; height: 4in; transform-origin: top left; transform: rotate(90deg) }
</style></head><body><div class="label"><img src="${id}?raw=1" alt="Postage label"></div></body></html>`;
    return new NextResponse(html, {
      headers: {
        ...safe,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      },
    });
  }
  return new NextResponse(Buffer.from(file.data, "base64"), {
    headers: {
      ...safe,
      "content-type": file.content_type,
      "content-disposition": `inline; filename="label-${file.box}.${TYPES[file.content_type]}"`,
    },
  });
}
