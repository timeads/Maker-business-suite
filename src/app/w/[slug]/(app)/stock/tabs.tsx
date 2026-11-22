import { SectionTabs } from "@/components/ui/section-tabs";

export function StockTabs({ slug }: { slug: string }) {
  const base = `/w/${slug}/stock`;
  return (
    <SectionTabs
      label="Stock"
      tabs={[
        { href: base, name: "To order", exact: true },
        { href: `${base}/items`, name: "Everything" },
        { href: `${base}/orders`, name: "Orders" },
        { href: `${base}/suppliers`, name: "Suppliers" },
        { href: `${base}/settings`, name: "Settings" },
      ]}
    />
  );
}
