import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { helpdeskAccess } from "@/app/w/[slug]/helpdesk/gate";
import { articleEntry, loadArticles, loadManualConfig } from "@/lib/helpdesk/manual/data";
import { searchEntries } from "@/lib/helpdesk/manual/search";
import { createClient } from "@/lib/supabase/server";
import { ManualTabs } from "../tabs";

export const metadata: Metadata = { title: "Knowledge base" };

const one = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) ?? "";

export default async function KnowledgeBasePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const access = await helpdeskAccess(slug, `/w/${slug}/helpdesk/manual/kb`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements } = access;
  const supabase = await createClient();
  const [config, articles] = await Promise.all([
    loadManualConfig(supabase, tenant.id),
    loadArticles(supabase, tenant.id),
  ]);
  const base = `/w/${tenant.slug}/helpdesk/manual/kb`;
  const q = one(sp.q).slice(0, 100);
  const tag = one(sp.tag).toLowerCase();
  const tagged = articles.filter((article) => !tag || article.tags.includes(tag));
  const byId = new Map(tagged.map((article) => [article.id, article]));
  const shown = searchEntries(tagged.map(articleEntry), q).map((entry) => byId.get(entry.id)!);
  const tags = [...new Set(articles.flatMap((article) => article.tags))].sort();
  const href = (next: { tag: string | null }) => {
    const query = new URLSearchParams();
    if (q) query.set("q", q);
    if (next.tag) query.set("tag", next.tag);
    const text = query.toString();
    return text ? `${base}?${text}` : base;
  };

  return (
    <>
      <PageHeader
        title={config.name}
        description="Articles the team writes: how things work, policies, answers worth keeping. One can be made a help article for customers to read on your help centre."
      >
        {entitlements.canWrite && (
          <Button asChild>
            <Link href={`${base}/new`}>New article</Link>
          </Button>
        )}
      </PageHeader>
      <ManualTabs slug={tenant.slug} topicsLabel={config.topics_label} />

      <div className="flex flex-col gap-3">
        <form action={base} className="relative max-w-xl">
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search articles and tags"
            aria-label="Search articles and tags"
            className="border-input bg-card focus-visible:border-ochre focus-visible:ring-ochre/25 h-10 w-full rounded-sm border pr-3 pl-9 text-sm outline-none focus-visible:ring-2"
          />
          {tag && <input type="hidden" name="tag" value={tag} />}
        </form>
        {tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground text-xs font-semibold">Tags</span>
            {tags.map((name) => (
              <Link
                key={name}
                href={href({ tag: tag === name ? null : name })}
                aria-pressed={tag === name}
                className={
                  tag === name
                    ? "bg-teal-soft text-teal-soft-ink rounded-full px-2.5 py-0.5 text-xs font-semibold"
                    : "border-border hover:bg-hover rounded-full border px-2.5 py-0.5 text-xs"
                }
              >
                {name}
              </Link>
            ))}
          </div>
        )}
      </div>

      {articles.length === 0 ? (
        <Card>
          <CardContent className="font-read flex flex-col gap-2 text-sm">
            <p className="font-sans font-semibold">No articles yet</p>
            <p className="text-muted-foreground max-w-prose">
              An article is anything the team looks up more than once: how a product is cared for,
              how returns work, what to say about sizing. They are for the team only, and can be
              dropped into a reply from the reply box.
            </p>
          </CardContent>
        </Card>
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing matches.{" "}
          <Link href={base} className="underline">
            Show everything
          </Link>
        </p>
      ) : (
        <ul className="bg-card border-border divide-border divide-y rounded-lg border">
          {shown.map((article) => (
            <li key={article.id}>
              <Link
                href={`${base}/${article.id}`}
                className="hover:bg-hover flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
              >
                <p className="min-w-0 flex-1 font-semibold">{article.title}</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {article.tags.slice(0, 4).map((name) => (
                    <Badge key={name}>{name}</Badge>
                  ))}
                  {article.publicState === "published" ? (
                    <Badge tone="good">On the help centre</Badge>
                  ) : article.publicState === "draft" ? (
                    <Badge tone="waiting">Help article · draft</Badge>
                  ) : (
                    article.shareable && <Badge tone="good">Fine to paste to a customer</Badge>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
