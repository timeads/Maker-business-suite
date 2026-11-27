import Link from "next/link";
import { BarList } from "@/components/charts/bar-list";
import { LineMultiples } from "@/components/charts/line-multiples";
import { StatTile } from "@/components/charts/stat-tile";
import { TimeChart } from "@/components/charts/time-chart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HowWorkedOut } from "@/components/setup/how-worked-out";
import type { WidgetData } from "@/lib/dashboard/data";
import {
  formatMoney,
  formatPercent,
  prepareSharedTimeCharts,
  prepareTimeChart,
} from "@/lib/dashboard/format";
import { FIGURE_WORDS, type RevenueFigure } from "@/lib/dashboard/lines";
import { CashFlow, HealthCheck, OperatingProfit, RevenueGrowth, Runway } from "./health-widgets";
import { ProfitTable } from "./profit-table";
import type { WidgetConfig, WidgetType } from "@/lib/dashboard/schema";

export const TITLES: Record<WidgetType, string> = {
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
  profit_by_line: "Profit by line",
  expenses_by_line: "Expenses by line",
  health_check: "How the business is doing",
  runway: "Runway and burn",
  revenue_growth: "Revenue growth",
  cash_flow: "Cash flow",
  operating_profit: "Operating profit",
};

const PROVIDER_NAMES = { shopify: "Shopify", quickbooks: "QuickBooks" } as const;

/** "net sales" or "order totals (with tax and shipping, refunds taken out)", for a sentence. */
const figureWords = (figure: RevenueFigure) =>
  figure === "net_sales"
    ? "net sales, after discounts and refunds, before tax and shipping"
    : "order totals, with tax and shipping, refunds taken out";

/** ", with $X from your books" for a sentence, when the books add anything. */
const booksWords = (books: { invoices: number; otherIncome: number }) =>
  books.invoices + books.otherIncome !== 0
    ? ", with paid invoices and other income from your books added"
    : ", with nothing from your books in this period";

const classWords = (byClassDate: boolean) =>
  byClassDate ? " Classes count in the month they run." : "";

const asOf = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );

function describe(data: WidgetData, range: string, currency: string): string | null {
  switch (data.type) {
    case "key_figures":
      return null;
    case "sales_over_time":
      return `${formatMoney(data.total, currency)} ${range}, in ${figureWords(data.figure)}`;
    case "gross_margin":
      if (data.overall === null) return null;
      return data.source === "books"
        ? `${formatPercent(data.overall)} overall, from your QuickBooks profit and loss`
        : `${formatPercent(data.overall)} on items with a cost recorded in Shopify`;
    case "sales_by_channel":
      return `${formatMoney(data.total, currency)} ${range}, in ${figureWords(data.figure)}`;
    case "top_products":
      return `By what the items sold for after discounts, ${range}`;
    case "revenue_by_line":
      return `${formatMoney(data.total, currency)} ${range}, in ${figureWords(data.figure)}${
        data.books ? booksWords(data.books) : ""
      }.${classWords(data.byClassDate)}`;
    case "revenue_by_line_over_time":
      return `${FIGURE_WORDS[data.figure].name} per line, each on the same scale${
        data.withBooks
          ? data.grouping === "month"
            ? ", with paid invoices and other income from your books"
            : ", with paid invoices from your books (other income joins by month)"
          : ""
      }.${classWords(data.byClassDate)}`;
    case "deferred_revenue":
      return `In ${figureWords(data.figure)}, for classes from today on.${
        data.byClassDate
          ? " Each counts in its line once its month comes."
          : " These already count in the month they were bought."
      }`;
    case "profit_by_line":
      return `${formatMoney(data.profit / 100, currency)} across your lines ${range}: revenue in ${figureWords(data.figure)}, less what each line costs.${classWords(data.byClassDate)}`;
    case "expenses_by_line":
      return `From your books ${range}: what's sorted to each line and its share of the shared costs. Money moved between your own accounts never counts.`;
    case "cash_on_hand":
      return `Across your bank accounts in QuickBooks, as of ${asOf(data.asOf)}`;
    case "ar_aging":
      return `${formatMoney(data.total, currency)} in unpaid invoices, as of ${asOf(data.asOf)}`;
    case "health_check":
      return "Healthy, worth watching or needing attention, by the thresholds in Settings → Money → Cash health.";
    case "runway":
      return `How long the cash in the bank would last, as of ${asOf(data.asOf)}`;
    case "revenue_growth":
      return "Revenue in your books, complete months only";
    case "cash_flow":
      return `Cash in less cash out each month ${range}, from your cash flow statement (cash basis)`;
    case "operating_profit":
      return `${formatMoney(data.profit / 100, currency)} ${range}: revenue less cost of goods and running costs, from your books${
        data.margin === null ? "" : `, ${formatPercent(data.margin)} of revenue`
      }`;
    default:
      return null;
  }
}

export function Widget({
  widget,
  data,
  currency,
  rangePhrase,
  connectionsHref,
  linesHref,
  inboxHref,
  profitHref,
  rulesHref = `${profitHref.replace(/\/profit$/, "")}/expenses#by-account`,
}: {
  widget: WidgetConfig;
  data: WidgetData;
  currency: string;
  /** The page's range in a sentence: "over the last 30 days", "last month". */
  rangePhrase: string;
  connectionsHref: string;
  /** Settings → Money, where business lines are set up. */
  linesHref: string;
  /** Money's expense inbox. */
  inboxHref: string;
  /** Settings → Money → Profit by line. */
  profitHref: string;
  /** Settings → Money → Sorting expenses, where each account's choice is made. */
  rulesHref?: string;
}) {
  const title = widget.title ?? TITLES[widget.type];
  const description = describe(data, rangePhrase, currency);

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
            note={`${rangePhrase.charAt(0).toUpperCase()}${rangePhrase.slice(1)}, ${
              data.figure === "net_sales"
                ? "before tax and shipping"
                : "with tax and shipping, refunds out"
            }${
              data.fromBooks
                ? `. Plus ${formatMoney(data.fromBooks / 100, currency)} from your books`
                : ""
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
        <div className="flex flex-col gap-3">
          <BarList rows={data.rows} currency={currency} emptyText="No sales in this period yet." />
          {data.books && <BooksNote books={data.books} currency={currency} linesHref={linesHref} />}
        </div>
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
    case "profit_by_line":
      body = (
        <div className="flex flex-col gap-4">
          <BarList
            rows={data.rows.map((row) => ({
              name: row.name,
              value: row.profit / 100,
              detail:
                row.profit < 0
                  ? "a loss"
                  : row.revenue > 0
                    ? `${formatPercent(row.profit / row.revenue)} of its revenue`
                    : undefined,
            }))}
            currency={currency}
            emptyText="No lines yet."
          />
          <ProfitTable data={data} currency={currency} />
          {data.books && <BooksNote books={data.books} currency={currency} linesHref={linesHref} />}
          <Feeds feeds={data.feeds} rulesHref={rulesHref} />
          <SetApart
            currency={currency}
            unsorted={data.unsorted}
            setAside={data.setAside}
            sharedUnsplit={data.sharedUnsplit}
            inboxHref={inboxHref}
            profitHref={profitHref}
          />
        </div>
      );
      break;
    case "expenses_by_line":
      body = (
        <div className="flex flex-col gap-4">
          <BarList
            rows={data.rows.map((row) => ({
              name: row.name,
              value: (row.direct + row.shared) / 100,
              detail:
                row.shared !== 0
                  ? `${formatMoney(row.direct / 100, currency)} its own, ${formatMoney(row.shared / 100, currency)} shared`
                  : undefined,
            }))}
            currency={currency}
            emptyText="No lines yet."
          />
          <SetApart
            currency={currency}
            unsorted={data.unsorted}
            setAside={data.setAside}
            sharedUnsplit={data.sharedUnsplit}
            inboxHref={inboxHref}
            profitHref={profitHref}
          />
          <Feeds feeds={data.feeds} rulesHref={rulesHref} />
        </div>
      );
      break;
    case "health_check":
      body = <HealthCheck data={data} currency={currency} linesHref={linesHref} />;
      break;
    case "runway":
      body = <Runway data={data} currency={currency} />;
      break;
    case "revenue_growth":
      body = <RevenueGrowth data={data} currency={currency} />;
      break;
    case "cash_flow":
      body = <CashFlow data={data} currency={currency} />;
      break;
    case "operating_profit":
      body = <OperatingProfit data={data} currency={currency} />;
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

/** "Which accounts feed each line": the account choices behind each line's own expenses. */
function Feeds({
  feeds,
  rulesHref,
}: {
  feeds: { id: string; name: string; lines: string[] }[];
  rulesHref: string;
}) {
  if (feeds.length === 0) return null;
  return (
    <HowWorkedOut
      label="Which accounts feed each line"
      lines={feeds.flatMap((feed) => feed.lines)}
      change={{ href: rulesHref, label: "Choose for each account" }}
    />
  );
}

/** What the books add, and what of theirs waits for a choice. */
function BooksNote({
  books,
  currency,
  linesHref,
}: {
  books: {
    invoices: number;
    otherIncome: number;
    otherUnplaced: number;
    waiting: number;
    otherUnknown: boolean;
  };
  currency: string;
  linesHref: string;
}) {
  const money = (cents: number) => formatMoney(cents / 100, currency);
  const notes: React.ReactNode[] = [];
  if (books.invoices !== 0) {
    notes.push(<li key="inv">{money(books.invoices)} of it is paid invoices from your books.</li>);
  }
  if (books.otherIncome !== 0) {
    notes.push(
      <li key="other">
        {money(books.otherIncome)} is your books&apos; other income
        {books.otherUnplaced !== 0 ? ", shown as other revenue" : ""}.
      </li>,
    );
  }
  if (books.otherUnknown) {
    notes.push(
      <li key="unknown">
        Some months were read before other income was, so it isn&apos;t known for them.
      </li>,
    );
  }
  if (books.waiting !== 0) {
    notes.push(
      <li key="waiting">
        {money(books.waiting)} of paid invoices is on accounts you haven&apos;t chosen a line for,
        so it isn&apos;t counted yet.{" "}
        <Link href={`${linesHref}#books`} className="text-foreground underline underline-offset-4">
          Choose
        </Link>
      </li>,
    );
  }
  if (notes.length === 0) return null;
  return <ul className="text-muted-foreground flex flex-col gap-1 text-xs">{notes}</ul>;
}

/** What isn't in a line's figures, in words, each with where to change it. */
function SetApart({
  currency,
  unsorted,
  setAside,
  sharedUnsplit,
  inboxHref,
  profitHref,
}: {
  currency: string;
  unsorted: number;
  setAside: number;
  sharedUnsplit: number;
  inboxHref: string;
  profitHref: string;
}) {
  const money = (cents: number) => formatMoney(cents / 100, currency);
  const notes: React.ReactNode[] = [];
  if (unsorted !== 0) {
    notes.push(
      <li key="unsorted">
        {money(unsorted)} of expenses aren&apos;t sorted into a line yet, so they&apos;re not in
        these figures.{" "}
        <Link href={inboxHref} className="text-foreground underline underline-offset-4">
          Sort them
        </Link>
      </li>,
    );
  }
  if (sharedUnsplit !== 0) {
    notes.push(
      <li key="unsplit">
        {money(sharedUnsplit)} of shared costs has no split to share it by yet.{" "}
        <Link href={profitHref} className="text-foreground underline underline-offset-4">
          Set the split
        </Link>
      </li>,
    );
  }
  if (setAside !== 0) {
    notes.push(<li key="aside">{money(setAside)} set aside as not business expenses.</li>);
  }
  if (notes.length === 0) return null;
  return <ul className="text-muted-foreground flex flex-col gap-1 text-xs">{notes}</ul>;
}
