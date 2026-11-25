import { sitemapXml } from "@/lib/helpdesk/help-centre/public";
import { helpCentreGate } from "@/lib/helpdesk/help-centre-gate";
import { getHelpCentre } from "@/lib/helpdesk/help-centre-server";
import { getSiteUrl } from "@/lib/site-url";

/** The sitemap of one workspace's help centre. "Not found" when there is none to show. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspace: string }> },
) {
  const { workspace } = await params;
  // The same check the pages get in front of them, asked fresh each time.
  const open = (await helpCentreGate(workspace, null)).kind === "ok";
  const centre = open ? await getHelpCentre(workspace) : null;
  if (!centre || centre.config.noindex) {
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
    });
  }
  return new Response(sitemapXml(await getSiteUrl(), centre.workspace.slug, centre.articles), {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
