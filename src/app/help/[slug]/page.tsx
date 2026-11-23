import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteFooter, SiteHeader } from "@/components/site/site-chrome";
import { HELP_GROUPS, HELP_TOPICS, topicBySlug } from "@/lib/help/topics";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return HELP_TOPICS.map((topic) => ({ slug: topic.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const topic = topicBySlug((await params).slug);
  return topic ? { title: `${topic.title} · Help`, description: topic.summary } : {};
}

export default async function HelpTopicPage({ params }: Props) {
  const topic = topicBySlug((await params).slug);
  if (!topic) notFound();
  const group = HELP_GROUPS.find((g) => g.key === topic.group);
  const related = HELP_TOPICS.filter((t) => t.group === topic.group && t.slug !== topic.slug);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-12 sm:px-6">
        <p className="text-muted-foreground text-sm">
          <Link href="/help" className="text-ochre-text font-medium hover:underline">
            Help
          </Link>{" "}
          / {group?.name}
        </p>
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-balance">{topic.title}</h1>
          {topic.intro ? <p className="font-read text-text-2 text-lg">{topic.intro}</p> : null}
        </div>

        {topic.steps ? (
          <ol className="bg-card border-border font-read flex list-decimal flex-col gap-3 rounded-xl border py-5 pr-5 pl-10">
            {topic.steps.map((step) => (
              <li key={step} className="pl-1 leading-relaxed">
                {step}
              </li>
            ))}
          </ol>
        ) : null}

        {topic.notes ? (
          <section className="bg-note border-note-border rounded-xl border p-5">
            <h2 className="text-sm font-semibold">Good to know</h2>
            <ul className="font-read mt-2 flex list-disc flex-col gap-2 pl-5">
              {topic.notes.map((note) => (
                <li key={note} className="leading-relaxed">
                  {note}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {related.length > 0 ? (
          <section>
            <h2 className="text-sm font-semibold">More on {group?.name.toLowerCase()}</h2>
            <ul className="mt-2 flex flex-col gap-1">
              {related.map((other) => (
                <li key={other.slug}>
                  <Link href={`/help/${other.slug}`} className="text-ochre-text hover:underline">
                    {other.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
      <SiteFooter />
    </>
  );
}
