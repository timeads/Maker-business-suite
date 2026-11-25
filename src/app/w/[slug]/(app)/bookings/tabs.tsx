import { SectionTabs } from "@/components/ui/section-tabs";

export function BookingsTabs({ slug }: { slug: string }) {
  const base = `/w/${slug}/bookings`;
  return (
    <SectionTabs
      label="Bookings"
      tabs={[
        { href: base, name: "Coming up", exact: true },
        { href: `${base}/calendar`, name: "Calendar" },
        { href: `${base}/customers`, name: "Customers" },
      ]}
      settings={{ href: `/w/${slug}/settings/bookings` }}
    />
  );
}
