import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { helpCentrePath } from "@/lib/helpdesk/help-centre/config";
import { describe, longDay, placePictures } from "@/lib/helpdesk/help-centre/public";
import { getHelpArticle } from "@/lib/helpdesk/help-centre-server";
import { getSiteUrl } from "@/lib/site-url";
import { PublicDoc } from "../doc";
import { HelpShell, centreTitle } from "../shell";
import { Helpful } from "./helpful";

type Props = { params: Promise<{ workspace: string; article: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { workspace, article: slug } = await params;
  const answer = await getHelpArticle(workspace, slug);
  if (!answer || answer.kind !== "article") return { title: "Not found", robots: { index: false } };
  const { centre, article } = answer;
  const title = `${article.title} · ${centreTitle(centre)}`;
  const description = describe(article);
  return {
    title: { absolute: title },
    description,
    alternates: {
      canonical: `${await getSiteUrl()}${helpCentrePath(centre.workspace.slug, article.slug)}`,
    },
    robots: centre.config.noindex ? { index: false } : undefined,
    openGraph: {
      title: article.title,
      description,
      type: "article",
      modifiedTime: article.updatedAt,
      images: article.pictures[0] ? [{ url: article.pictures[0].url }] : undefined,
    },
  };
}

/** One published help article. */
export default async function HelpArticlePage({ params }: Props) {
  const { workspace, article: slug } = await params;
  const answer = await getHelpArticle(workspace, slug);
  if (!answer) notFound();
  // An address it used to have: on to the one it has now, for good.
  if (answer.kind === "moved") permanentRedirect(helpCentrePath(workspace, answer.slug));
  const { centre, article } = answer;
  const category = centre.config.categories.find((c) => c.id === article.category);
  const updated = longDay(article.updatedAt, centre.workspace.timezone);

  return (
    <HelpShell centre={centre}>
      <article className="flex flex-col gap-8">
        <header className="flex flex-col gap-2">
          <p className="text-sm">
            <Link
              href={helpCentrePath(centre.workspace.slug)}
              className="text-ochre-text font-medium hover:underline"
            >
              All articles
            </Link>
            {category && <span className="text-muted-foreground"> / {category.label}</span>}
          </p>
          <h1 className="text-3xl font-bold tracking-[-0.02em] text-balance">{article.title}</h1>
          {article.summary && <p className="text-text-2 font-read text-lg">{article.summary}</p>}
          {updated && (
            <p className="text-muted-foreground text-sm">
              Last updated <time dateTime={article.updatedAt}>{updated}</time>
            </p>
          )}
        </header>
        <PublicDoc sections={placePictures(article.body, article.pictures)} />
      </article>
      <Helpful workspace={centre.workspace.slug} article={article.slug} />
    </HelpShell>
  );
}
