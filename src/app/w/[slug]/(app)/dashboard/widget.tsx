import Link from "next/link";
import { BarList } from "@/components/charts/bar-list";
import { LineMultiples } from "@/components/charts/line-multiples";
import { StatTile } from "@/components/charts/stat-tile";
import { TimeChart } from "@/components/charts/time-chart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { WidgetData } from "@/lib/dashboard/data";
import {
  formatMoney,
  formatPercent,
  prepareSharedTimeCharts,
  prepareTimeChart,
} from "@/lib/dashboard/format";
import { FIGURE_WORDS, type RevenueFigure } from "@/lib/dashboard/lines";
import type { WidgetConfig, WidgetType } from "@/lib/dashboard/schema";

const TITLES: Record<WidgetType, string> = {
  key_figures: "At a glance",
  sales_over_time: "Sales",
  gross_margin: "Gross margin",
  top_products: "Best sellers",
  sales_by_channel: "Where sales come from",
  cash_on_hand: "Cash in the bank",
  ar_aging: "What you're owed",
  revenue_by_line: "Your business lines",
  revenue_by_line_over_time: "Your business lines over time",
  deferred_revenue: "Paid for classes still to come",
};

const PROVIDER_NAMES = { shopify: "Shopify", quickbooks: "QuickBooks" } as const;

/** "net sales" or "order totals (with tax and shipping, refunds taken out)", for a sentence. */
const figureWords = (figure: RevenueFigure) =>
  figure === "net_sales"
    ? "net sales, after discounts and refunds, before tax and shipping"
    : "order totals, with tax and shipping, refunds taken out";

const classWords = (byClassDate: boolean) =>
  byClassDate ? " Classes count in the month they run." : "";

const asOf = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );

function describe(data: WidgetData, rangeLabel: string, currency: string): string | null {
  switch (data.type) {
    case "key_figures":
      return null;
    case "sales_over_time":
      return `${formatMoney(data.total, currency)} over the last ${rangeLabel}, in ${figureWords(data.figure)}`;
    case "gross_margin":
      if (data.overall === null) return null;
      return data.source === "books"
        ? `${formatPercent(data.overall)} overall, from your QuickBooks profit and loss`
        : `${formatPercent(data.overall)} on items with a cost recorded in Shopify`;
    case "sales_by_channel":
      return `${formatMoney(data.total, currency)} over the last ${rangeLabel}, in ${figureWords(data.figure)}`;
    case "top_products":
      return `By what the items sold for after discounts, over the last ${rangeLabel}`;
    case "revenue_by_line":
      return `${formatMoney(data.total, currency)} over the last ${rangeLabel}, in ${figureWords(data.figure)}.${classWords(data.byClassDate)}`;
    case "revenue_by_line_over_time":
      return `${FIGURE_WORDS[data.figure].name} per line, each on the same scale.${classWords(data.byClassDate)}`;
    case "deferred_revenue":
      return `In ${figureWords(data.figure)}, for classes from today on.${
        data.byClassDate
          ? " Each counts in its line once its month comes."
          : " These already count in the month they were bought."
      }`;
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
  linesHref,
}: {
  widget: WidgetConfig;
  data: WidgetData;
  currency: string;
  rangeLabel: string;
  connectionsHref: string;
  /** Settings → Money, where business lines are set up. */
  linesHref: string;
}) {
  const title = widget.title ?? TITLES[widget.type];
  const description = describe(data, rangeLabel.toLowerCase(), currency);

  let body: React.ReactNode;
  switch (data.type) {
    case "empty":
      body =
        data.needs === "lines" ? (
          <p className="text-muted-foreground text-sm">
            Tell Money how your business splits up (shop, classes, commissions…) and this shows each
            part.{" "}
            <Link href={linesHref} className="text-foreground underline underline-offset-4">
              Set up your business lines
            </Link>
          </p>
        ) : (
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
            label={FIGURE_WORDS[data.figure].name}
            value={formatMoney(data.sales, currency)}
            note={`Last ${rangeLabel.toLowerCase()}, ${
              data.figure === "net_sales"
                ? "before tax and shipping"
                : "with tax and shipping, refunds out"
            }`}
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
          valueLabel={FIGURE_WORDS[data.figure].name}
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
    case "revenue_by_line":
      body = (
        <BarList rows={data.rows} currency={currency} emptyText="No sales in this period yet." />
      );
      break;
    case "revenue_by_line_over_time": {
      const shared = prepareSharedTimeCharts(
        data.series.map((line) => line.points),
        "money",
        currency,
      );
      body = (
        <LineMultiples
          ticks={shared.ticks}
          valueLabel={FIGURE_WORDS[data.figure].name}
          series={data.series.map((line, index) => ({
            id: line.id,
            name: line.name,
            total: formatMoney(line.total, currency),
            points: shared.series[index],
          }))}
        />
      );
      break;
    }
    case "deferred_revenue":
      body = (
        <div className="flex flex-col gap-4">
          <StatTile
            label="Already paid"
            value={formatMoney(data.total, currency)}
            note={`${data.places.toLocaleString("en-US")} ${data.places === 1 ? "place" : "places"} booked`}
          />
          {data.rows.length > 0 && <BarList rows={data.rows} currency={currency} emptyText="" />}
          {data.total === 0 && (
            <p className="text-muted-foreground text-sm">
              Nothing paid ahead yet. Classes sold through your shop show here once Bookings has
              their dates.
            </p>
          )}
        </div>
      );
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
