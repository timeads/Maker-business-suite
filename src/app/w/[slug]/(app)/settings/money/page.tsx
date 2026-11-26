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
          name: "Cash health",
          about:
            "Where runway, growth, margin and one line's share count as healthy or worth watching.",
          href: "settings/money/health",
        },
        {
          name: "Budget and break-even",
          about: "Your cost of goods share, costs that rise with sales, and accounts left off.",
          href: "settings/money/budget",
        },
        {
          name: "Cost cutter",
          about: "How recurring charges are found, what's left out and when they're flagged.",
          href: "settings/money/cost-cutter",
        },
        {
          name: "Budget and cost cutter",
          about: "The budget you type in and your decisions on each charge are on Money itself.",
          href: "dashboard/budget",
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
