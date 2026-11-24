import { SectionTabs } from "@/components/ui/section-tabs";

export function MichaelsTabs({ slug }: { slug: string }) {
  const base = `/w/${slug}/stock/michaels`;
  return (
    <SectionTabs
      label="Michaels"
      tabs={[
        { href: base, name: "Overview", exact: true },
        { href: `${base}/listings`, name: "Listings" },
        { href: `${base}/would-send`, name: "Would send" },
        { href: `${base}/orders`, name: "Orders" },
        { href: `${base}/settings`, name: "Settings" },
      ]}
    />
  );
}

/** On every Michaels page: this stage only watches. */
export function WatchingBanner() {
  return (
    <p className="bg-teal-soft text-teal-soft-ink rounded-md px-3 py-2 text-sm font-medium">
      Watching only — nothing is sent. We read your Michaels account and work out what would change.
      Nothing on Michaels and nothing in your shop is touched.
    </p>
  );
}
