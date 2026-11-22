import Link from "next/link";
import { BarList } from "@/components/charts/bar-list";
import { StatTile } from "@/components/charts/stat-tile";
import { TimeChart } from "@/components/charts/time-chart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { WidgetData } from "@/lib/dashboard/data";
import { formatMoney, formatPercent, prepareTimeChart } from "@/lib/dashboard/format";
import type { WidgetConfig, WidgetType } from "@/lib/dashboard/schema";

const TITLES: Record<WidgetType, string> = {
  key_figures: "At a glance",
  sales_over_time: "Sales",
  gross_margin: "Gross margin",
  top_products: "Best sellers",
  sales_by_channel: "Where sales come from",
  cash_on_hand: "Cash in the bank",
  ar_aging: "What you're owed",
};

const PROVIDER_NAMES = { shopify: "Shopify", quickbooks: "QuickBooks" } as const;

const asOf = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );

function describe(data: WidgetData, rangeLabel: string, currency: string): string | null {
  switch (data.type) {
    case "sales_over_time":
      return `${formatMoney(data.total, currency)} over the last ${rangeLabel}, after discounts and refunds`;
    case "gross_margin":
      if (data.overall === null) return null;
      return data.source === "books"
        ? `${formatPercent(data.overall)} overall, from your QuickBooks profit and loss`
        : `${formatPercent(data.overall)} on items with a cost recorded in Shopify`;
    case "sales_by_channel":
      return `${formatMoney(data.total, currency)} over the last ${rangeLabel}`;
    case "top_products":
      return `By sales over the last ${rangeLabel}`;
    case "cash_on_hand":
      return `Across your bank accounts in QuickBooks, as of ${asOf(data.asOf)}`;
    case "ar_aging":
      return `${formatMoney(data.total, currency)} in unpaid invoices, as of ${asOf(data.asOf)}`;
    default:
      return null;
  }
}

export function Widget({
  widget,
  data,
  currency,
  rangeLabel,
  connectionsHref,
}: {
  widget: WidgetConfig;
  data: WidgetData;
  currency: string;
  rangeLabel: string;
  connectionsHref: string;
}) {
  const title = widget.title ?? TITLES[widget.type];
  const description = describe(data, rangeLabel.toLowerCase(), currency);

  let body: React.ReactNode;
  switch (data.type) {
    case "empty":
      body = (
        <p className="text-muted-foreground text-sm">
          This fills in once {PROVIDER_NAMES[data.needs]} is connected and has synced.{" "}
          <Link href={connectionsHref} className="text-foreground underline underline-offset-4">
            Go to Connections
          </Link>
        </p>
      );
      break;
    case "key_figures":
      body = (
        <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
          <StatTile
            label="Sales"
            value={formatMoney(data.sales, currency)}
            note={`Last ${rangeLabel.toLowerCase()}`}
          />
          <StatTile label="Orders" value={data.orders.toLocaleString("en-US")} />
          <StatTile
            label="Average order"
            value={data.averageOrder === null ? "—" : formatMoney(data.averageOrder, currency)}
          />
          <StatTile
            label="Gross margin"
            value={data.margin === null ? "—" : formatPercent(data.margin)}
            note={data.margin === null ? "Needs item costs or QuickBooks" : undefined}
          />
        </div>
      );
      break;
    case "sales_over_time":
      body = (
        <TimeChart
          {...prepareTimeChart(data.points, "money", currency)}
          variant="column"
          valueLabel="Sales"
        />
      );
      break;
    case "gross_margin":
      body = (
        <>
          <TimeChart
            {...prepareTimeChart(data.points, "percent", currency)}
            variant="line"
            valueLabel="Gross margin"
          />
          {data.source === "store" && data.coverage !== null && data.coverage < 0.95 && (
            <p className="text-muted-foreground mt-3 text-xs">
              Based on the {formatPercent(data.coverage)} of sales where the item has a cost set in
              Shopify. Add costs to your products, or connect QuickBooks, for the full picture.
            </p>
          )}
        </>
      );
      break;
    case "top_products":
      body = (
        <BarList rows={data.rows} currency={currency} emptyText="No sales in this period yet." />
      );
      break;
    case "sales_by_channel":
      body = (
        <BarList rows={data.rows} currency={currency} emptyText="No sales in this period yet." />
      );
      break;
    case "cash_on_hand":
      body = <StatTile label="Total" value={formatMoney(data.cash, currency)} />;
      break;
    case "ar_aging":
      body = (
        <BarList rows={data.rows} currency={currency} emptyText="Nobody owes you anything. Nice." />
      );
      break;
  }

  // The key figures row is its own heading; a card title would repeat it.
  if (data.type === "key_figures") {
    return (
      <Card className={widget.size === "full" ? "lg:col-span-2" : undefined}>
        <CardContent>{body}</CardContent>
      </Card>
    );
  }
  return (
    <Card className={widget.size === "full" ? "lg:col-span-2" : undefined}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
