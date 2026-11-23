import { SectionTabs } from "@/components/ui/section-tabs";

/** `manager` adds the tabs only owners and admins can use. */
export function StockTabs({ slug, manager = false }: { slug: string; manager?: boolean }) {
  const base = `/w/${slug}/stock`;
  return (
    <SectionTabs
      label="Stock"
      tabs={[
        { href: base, name: "To order", exact: true },
        { href: `${base}/items`, name: "Everything" },
        { href: `${base}/orders`, name: "Orders" },
        { href: `${base}/suppliers`, name: "Suppliers" },
        ...(manager
          ? [
              { href: `${base}/balances`, name: "Balances" },
              { href: `${base}/spend`, name: "Spend" },
            ]
          : []),
        { href: `${base}/settings`, name: "Settings" },
      ]}
    />
  );
}
