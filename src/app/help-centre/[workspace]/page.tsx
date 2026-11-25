import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { helpCentrePath } from "@/lib/helpdesk/help-centre/config";
import { groupByCategory, tidyQuery, type PublicCard } from "@/lib/helpdesk/help-centre/public";
import { getHelpCentre, searchHelpCentre, visitorAddress } from "@/lib/helpdesk/help-centre-server";
import { getSiteUrl } from "@/lib/site-url";
import { HelpShell, centreTitle } from "./shell";

type Props = {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
};

const asked = (q: string | string[] | undefined) => tidyQuery(Array.isArray(q) ? q[0] : q);

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { workspace } = await params;
  const centre = await getHelpCentre(workspace);
  if (!centre) return { title: "Not found", robots: { index: false } };
  const searching = asked((await searchParams).q) !== "";
  const title = centreTitle(centre);
  const description =
    centre.config.intro || `Answers to common questions from ${centre.workspace.name}.`;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: `${await getSiteUrl()}${helpCentrePath(centre.workspace.slug)}` },
    // A page of search results is never one to index.
    robots: centre.config.noindex || searching ? { index: false, follow: !searching } : undefined,
    openGraph: { title, description, type: "website" },
  };
}

function Cards({ workspace, cards }: { workspace: string; cards: PublicCard[] }) {
  return (
    <ul className="bg-card border-border divide-border flex flex-col divide-y rounded-xl border">
      {cards.map((card) => (
        <li key={card.slug}>
          <Link
            href={helpCentrePath(workspace, card.slug)}
            className="hover:bg-hover focus-visible:ring-ochre flex flex-col gap-0.5 px-4 py-3.5 outline-none first:rounded-t-xl last:rounded-b-xl focus-visible:ring-2 sm:px-5"
          >
            <span className="font-semibold">{card.title}</span>
            {card.summary && (
              <span className="text-text-2 font-read text-sm leading-snug">{card.summary}</span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A business's help centre: its published help articles, by category, with search. */
export default async function HelpCentrePage({ params, searchParams }: Props) {
  const { workspace } = await params;
  const centre = await getHelpCentre(workspace);
  if (!centre) notFound();
  const query = asked((await searchParams).q);
  const slug = centre.workspace.slug;

  if (query) {
    const answer = await searchHelpCentre(slug, query, visitorAddress(await headers()));
    if (!answer) notFound();
    return (
      <HelpShell centre={centre} query={query}>
        <div className="flex flex-col gap-1">
          <p className="text-sm">
            <Link
              href={helpCentrePath(slug)}
              className="text-ochre-text font-medium hover:underline"
            >
              All articles
            </Link>
          </p>
          <h1 className="text-2xl font-bold tracking-[-0.015em] text-balance">
            Results for “{query}”
          </h1>
        </div>
        {answer.kind === "slow_down" ? (
          <p className="font-read" role="status">
            That&apos;s a lot of searches in a short while. Give it a minute and try again.
          </p>
        ) : answer.results.length === 0 ? (
          <p className="font-read" role="status">
            Nothing matched. Try fewer or different words
            {centre.contactEmail ? ", or write to us with the address below." : "."}
          </p>
        ) : (
          <Cards workspace={slug} cards={answer.results} />
        )}
      </HelpShell>
    );
  }

  const groups = groupByCategory(centre.articles, centre.config.categories);
  return (
    <HelpShell centre={centre}>
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-[-0.02em] text-balance">
          {centreTitle(centre)}
        </h1>
        {centre.config.intro && (
          <p className="text-text-2 font-read text-lg">{centre.config.intro}</p>
        )}
      </div>
      {groups.length === 0 ? (
        <p className="font-read">There&apos;s nothing here just yet. Check back soon.</p>
      ) : (
        groups.map((group) => (
          <section key={group.id ?? "rest"} className="flex flex-col gap-3">
            <h2 className="text-sm font-bold tracking-[0.04em] uppercase">{group.label}</h2>
            <Cards workspace={slug} cards={group.articles} />
          </section>
        ))
      )}
    </HelpShell>
  );
}
