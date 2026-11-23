import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "@/components/site/site-chrome";
import { HELP_GROUPS, HELP_TOPICS } from "@/lib/help/topics";
import { HelpIndex } from "./help-index";

export const metadata: Metadata = {
  title: "Help",
  description: "Short how-tos for every tool in the Maker Business Suite.",
};

export default function HelpPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-12 sm:px-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">How can we help?</h1>
          <p className="text-muted-foreground text-lg">
            Short how-tos for every tool. Search, or pick a topic below.
          </p>
        </div>
        <HelpIndex
          groups={HELP_GROUPS.map((group) => ({ key: group.key, name: group.name }))}
          topics={HELP_TOPICS.map(({ slug, group, title, summary, intro, steps, notes }) => ({
            slug,
            group,
            title,
            summary,
            text: [title, summary, intro, ...(steps ?? []), ...(notes ?? [])]
              .join(" ")
              .toLowerCase(),
          }))}
        />
      </main>
      <SiteFooter />
    </>
  );
}
