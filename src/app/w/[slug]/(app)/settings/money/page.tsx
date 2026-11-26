import type { Metadata } from "next";
import { WhereThingsLive } from "@/components/settings/where-things-live";

export const metadata: Metadata = { title: "Money settings" };

export default async function MoneySettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <WhereThingsLive
      slug={slug}
      path="money"
      feature="module.dashboard"
      tool={{ href: "dashboard", label: "Money" }}
      title="Money"
      description="What your sales, margins and cash are read from, and how they're shown."
      pointers={[
        {
          name: "Revenue and business lines",
          about:
            "Net sales or order totals, classes in the month they run, and your own business lines.",
          href: "settings/money/lines",
        },
        {
          name: "Dashboard layout",
          about: "Pick a layout on Money itself, or ask the Assistant to change what it shows.",
          href: "dashboard",
        },
        {
          name: "Currency and time zone",
          about: "Money follows the workspace's own, under Settings, Workspace.",
          href: "settings",
        },
        {
          name: "Connections",
          about: "Connect your shop and your books, where the figures come from.",
          href: "connections",
        },
      ]}
    />
  );
}
