import { SectionTabs } from "@/components/ui/section-tabs";

export function ShippingTabs({ slug }: { slug: string }) {
  const base = `/w/${slug}/shipping`;
  return (
    <SectionTabs
      label="Shipping"
      tabs={[
        { href: base, name: "To send", exact: true },
        { href: `${base}/sent`, name: "Sent" },
        { href: `${base}/settings`, name: "Settings" },
      ]}
    />
  );
}
