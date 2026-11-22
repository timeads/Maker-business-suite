import { SectionTabs } from "@/components/ui/section-tabs";

export function SocialTabs({ slug }: { slug: string }) {
  const base = `/w/${slug}/social`;
  return (
    <SectionTabs
      label="Social"
      tabs={[
        { href: base, name: "Calendar", exact: true },
        { href: `${base}/library`, name: "Photos" },
        { href: `${base}/projects`, name: "Projects" },
        { href: `${base}/plan`, name: "Plan" },
        { href: `${base}/links`, name: "Link page" },
      ]}
    />
  );
}
