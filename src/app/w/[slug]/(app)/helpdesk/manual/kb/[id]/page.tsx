import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { helpdeskAccess } from "@/app/w/[slug]/helpdesk/gate";
import { HELPDESK_MODULE } from "@/lib/helpdesk/config";
import {
  HELP_CENTRE_KEY,
  helpCentrePath,
  parseHelpCentre,
} from "@/lib/helpdesk/help-centre/config";
import { publicPictureUrl } from "@/lib/helpdesk/help-centre/public";
import { loadArticle, manualDay } from "@/lib/helpdesk/manual/data";
import { splitSections } from "@/lib/helpdesk/manual/sections";
import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { deleteArticle, saveArticle } from "../../actions";
import { DocView } from "../../doc-view";
import { EntryForm } from "../../editor";
import { setArticlePublicState } from "../../help-actions";
import { ArticleDetailsForm, PictureRow, PictureUploader } from "../../help-forms";

const STATES = {
  internal: { tone: "closed", words: "For the team only" },
  draft: { tone: "waiting", words: "Help article · draft" },
  published: { tone: "good", words: "Published on the help centre" },
} as const;

type PictureRecord = {
  id: string;
  storage_path: string;
  alt: string;
  caption: string;
  section: string;
  position: number;
};

export const metadata: Metadata = { title: "Article" };

export default async function ArticlePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, id } = await params;
  const editing = (await searchParams).edit === "1";
  const access = await helpdeskAccess(slug, `/w/${slug}/helpdesk/manual/kb/${id}`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const supabase = await createClient();
  const article = await loadArticle(supabase, tenant.id, id);
  if (!article) notFound();
  const manager = canManage(role);
  // A published article is on a public page: from then on only owners and admins change it.
  const mayEdit = entitlements.canWrite && (article.publicState !== "published" || manager);
  const base = `/w/${tenant.slug}/helpdesk/manual/kb`;
  const here = `${base}/${article.id}`;

  if (editing) {
    return (
      <>
        <PageHeader title="Edit article" back={{ href: here, label: article.title }} />
        <EntryForm
          action={saveArticle.bind(null, tenant.slug, article.id)}
          kind="article"
          initial={{
            title: article.title,
            body: article.body,
            tags: article.tags.join(", "),
            shareable: article.shareable,
          }}
          cancelHref={here}
          canEdit={mayEdit}
        />
      </>
    );
  }

  const [{ data: centreRow }, { data: pictureRows }, site] = await Promise.all([
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", HELPDESK_MODULE)
      .eq("key", HELP_CENTRE_KEY)
      .maybeSingle(),
    supabase
      .from("help_article_pictures")
      .select("id, storage_path, alt, caption, section, position")
      .eq("tenant_id", tenant.id)
      .eq("article_id", article.id)
      .order("position")
      .order("created_at"),
    getSiteUrl(),
  ]);
  const centre = parseHelpCentre(centreRow?.body);
  const pictures = ((pictureRows ?? []) as PictureRecord[]).flatMap((row) => {
    const url = publicPictureUrl(row.storage_path, process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    return url ? [{ ...row, url }] : [];
  });
  const headings = splitSections(article.body).flatMap((s) => (s.heading ? [s.heading] : []));
  const publicUrl = article.slug ? `${site}${helpCentrePath(tenant.slug, article.slug)}` : null;
  const isPublic = article.publicState !== "internal";
  const state = STATES[article.publicState];
  const setState = (next: "internal" | "draft" | "published") =>
    setArticlePublicState.bind(null, tenant.slug, article.id, next);

  return (
    <>
      <PageHeader title={article.title} back={{ href: base, label: "Knowledge base" }}>
        {mayEdit && (
          <Button asChild variant="outline">
            <Link href={`${here}?edit=1`}>Edit</Link>
          </Button>
        )}
      </PageHeader>
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        {article.tags.map((name) => (
          <Badge key={name} tone="open">
            {name}
          </Badge>
        ))}
        <Badge tone={state.tone}>{state.words}</Badge>
        {!isPublic && article.shareable && <Badge tone="good">Fine to paste to a customer</Badge>}
        <span className="text-muted-foreground">
          Updated {manualDay(article.updatedAt, tenant.timezone)}
        </span>
      </div>
      <Card>
        <CardContent>
          <DocView doc={article.body} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Help centre</CardTitle>
          <CardDescription>
            {article.publicState === "internal"
              ? "This article is for the team. A help article is one customers can read on your help centre; making it one starts it as a draft, and nothing is public until it is published."
              : article.publicState === "draft"
                ? "A draft: customers can't see it yet. Read it as a customer would, then publish."
                : centre.on
                  ? "Customers can read this. Changes you save show there straight away."
                  : "Published, but your help centre is switched off, so nobody can see it yet. Switch it on in Settings."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {article.publicState === "published" && publicUrl && (
            <p className="text-sm break-all">
              {centre.on ? (
                <a href={publicUrl} className="text-ochre-text underline">
                  {publicUrl}
                </a>
              ) : (
                <span className="text-muted-foreground">{publicUrl}</span>
              )}
              <span className="text-muted-foreground">
                {" "}
                · Helpful: {article.helpfulYes} yes, {article.helpfulNo} no
              </span>
            </p>
          )}
          {manager && entitlements.canWrite ? (
            <div className="flex flex-wrap items-center gap-2">
              {article.publicState === "internal" && (
                <form action={setState("draft")}>
                  <Button type="submit" variant="outline">
                    Make this a help article
                  </Button>
                </form>
              )}
              {article.publicState === "draft" && (
                <>
                  <form action={setState("published")}>
                    <Button type="submit">Publish to the help centre</Button>
                  </form>
                  <form action={setState("internal")}>
                    <Button type="submit" variant="ghost">
                      Keep it for the team only
                    </Button>
                  </form>
                </>
              )}
              {article.publicState === "published" && (
                <form action={setState("draft")}>
                  <Button type="submit" variant="outline">
                    Unpublish
                  </Button>
                </form>
              )}
              {!centre.on && isPublic && (
                <Link
                  href={`/w/${tenant.slug}/settings/helpdesk/help-centre`}
                  className="text-ochre-text text-sm underline"
                >
                  Help centre settings
                </Link>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              An owner or admin decides what is published on the help centre.
            </p>
          )}

          {isPublic && (
            <>
              {mayEdit ? (
                <div className="border-border border-t pt-5">
                  <ArticleDetailsForm
                    slug={tenant.slug}
                    articleId={article.id}
                    initial={{
                      slug: article.slug ?? "",
                      category: centre.categories.some((c) => c.id === article.category)
                        ? (article.category ?? "")
                        : "",
                      summary: article.summary,
                    }}
                    categories={centre.categories}
                    addressStart={`${site.replace(/^https?:\/\//, "")}${helpCentrePath(tenant.slug)}/`}
                  />
                </div>
              ) : (
                article.summary && <p className="font-read text-sm">{article.summary}</p>
              )}
              <div className="border-border flex flex-col gap-3 border-t pt-5">
                <div>
                  <p className="text-sm font-bold">Pictures</p>
                  <p className="text-muted-foreground font-read text-xs">
                    Your own pictures for this article, up to twelve. They are public once the
                    article is. Photos customers sent you are never used here.
                  </p>
                </div>
                {pictures.length > 0 && (
                  <ul className="flex flex-col gap-3">
                    {pictures.map((picture) => (
                      <PictureRow
                        key={picture.id}
                        slug={tenant.slug}
                        picture={picture}
                        headings={headings}
                        canEdit={mayEdit}
                      />
                    ))}
                  </ul>
                )}
                {mayEdit && pictures.length < 12 && (
                  <PictureUploader slug={tenant.slug} articleId={article.id} />
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {manager && entitlements.canWrite && (
        <details className="border-border border-t pt-4 text-sm">
          <summary className="text-muted-foreground cursor-pointer">Delete this article…</summary>
          <form
            action={deleteArticle.bind(null, tenant.slug, article.id)}
            className="mt-2 flex flex-col items-start gap-2"
          >
            <p className="font-read">It goes for good.</p>
            <Button type="submit" variant="outline" size="sm">
              Delete for good
            </Button>
          </form>
        </details>
      )}
    </>
  );
}
