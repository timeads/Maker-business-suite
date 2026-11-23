import { PageHeader } from "@/components/ui/page-header";
import { SectionTabs } from "@/components/ui/section-tabs";

export default async function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const base = `/w/${slug}/settings`;
  return (
    <>
      <PageHeader title="Settings" />
      <SectionTabs
        label="Settings"
        tabs={[
          { href: base, name: "Workspace", exact: true },
          { href: `${base}/brand`, name: "Brand kit" },
          { href: `${base}/team`, name: "Team" },
          { href: `${base}/billing`, name: "Billing" },
        ]}
      />
      {children}
    </>
  );
}
