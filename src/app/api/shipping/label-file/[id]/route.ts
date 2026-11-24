import { NextResponse } from "next/server";
import { getEntitlements } from "@/lib/entitlements";
import {
  labelPageCsp,
  labelPictureSize,
  labelPrintPage,
  liesSideways,
} from "@/lib/shipping/label-page";
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
 * A label kept as a picture is shown, by default, on a page that prints it at
 * exactly 4 × 6 inches with no margin (so the browser adds no header or
 * footer and nothing is cut off or spread over two stickers), fitted whole
 * and stood upright: a UPS GIF always lies on its side, and a PNG is turned
 * only when its own header says it is wider than tall. `?raw=1` is the file
 * itself. A PDF is always the file, shown by the browser's own viewer, which
 * prints it at the page size the carrier drew it at.
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
    .select("tenant_id, content_type, data, box, quote_id")
    .eq("id", id)
    .maybeSingle();
  const file = data as {
    tenant_id: string;
    content_type: string;
    data: string;
    box: number;
    quote_id: string;
  } | null;
  if (!file || !TYPES[file.content_type]) return missing();
  if (!(await getEntitlements(file.tenant_id)).can("module.shipping")) return missing();

  const safe = {
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  const raw = new URL(request.url).searchParams.get("raw") === "1";
  const picture = file.content_type === "image/gif" || file.content_type === "image/png";
  if (picture && !raw) {
    // Redo's pictures can sit inside wide white margins; the page trims them before it prints.
    const { data: quote } = await supabase
      .from("shipping_label_quotes")
      .select("provider")
      .eq("id", file.quote_id)
      .maybeSingle();
    const gif = file.content_type === "image/gif";
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64");
    // Nothing from the label goes into this page but its own address.
    const html = labelPrintPage({
      id,
      // A UPS GIF has always been turned; a PNG only when its header says it lies on its side.
      sideways: gif || liesSideways(labelPictureSize(file.content_type, file.data)),
      stretch: gif,
      crop: (quote as { provider?: string } | null)?.provider === "redo",
      nonce,
    });
    return new NextResponse(html, {
      headers: {
        ...safe,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": labelPageCsp(nonce),
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
