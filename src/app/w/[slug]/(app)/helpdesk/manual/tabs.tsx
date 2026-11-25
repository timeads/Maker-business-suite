import { SectionTabs } from "@/components/ui/section-tabs";

/** The manual's two views: topics written from conversations, and the team's own articles. */
export function ManualTabs({ slug, topicsLabel }: { slug: string; topicsLabel: string }) {
  const base = `/w/${slug}/helpdesk/manual`;
  return (
    <SectionTabs
      label="Parts of the manual"
      tabs={[
        { href: base, name: topicsLabel, exact: true },
        { href: `${base}/kb`, name: "Knowledge base" },
      ]}
    />
  );
}
