import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { helpdeskAccess } from "@/app/w/[slug]/helpdesk/gate";
import { loadArticle, manualDay } from "@/lib/helpdesk/manual/data";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { deleteArticle, saveArticle } from "../../actions";
import { DocView } from "../../doc-view";
import { EntryForm } from "../../editor";

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
  const article = await loadArticle(await createClient(), tenant.id, id);
  if (!article) notFound();
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
          canEdit={entitlements.canWrite}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader title={article.title} back={{ href: base, label: "Knowledge base" }}>
        {entitlements.canWrite && (
          <Button asChild>
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
        <Badge tone={article.shareable ? "good" : "closed"}>
          {article.shareable ? "Fine to paste to a customer" : "For the team only"}
        </Badge>
        <span className="text-muted-foreground">
          Updated {manualDay(article.updatedAt, tenant.timezone)}
        </span>
      </div>
      <Card>
        <CardContent>
          <DocView doc={article.body} />
        </CardContent>
      </Card>
      {canManage(role) && entitlements.canWrite && (
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
