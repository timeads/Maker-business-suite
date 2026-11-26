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
          name: "Sorting expenses",
          about: "Payee defaults and rules that sort the expenses from your books into lines.",
          href: "settings/money/expenses",
        },
        {
          name: "Profit by line",
          about: "Cost of goods, how shared costs split, and monthly costs your books don't hold.",
          href: "settings/money/profit",
        },
        {
          name: "Expenses to sort",
          about: "The inbox itself is on Money, with the expenses still waiting for a line.",
          href: "dashboard/expenses",
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
