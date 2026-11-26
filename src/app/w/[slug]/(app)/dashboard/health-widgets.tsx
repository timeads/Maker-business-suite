import Link from "next/link";
import { StatTile } from "@/components/charts/stat-tile";
import { TimeChart } from "@/components/charts/time-chart";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import type { WidgetData } from "@/lib/dashboard/data";
import { formatMoney, formatPercent, prepareTimeChart } from "@/lib/dashboard/format";
import { STANDING_WORDS, type Standing } from "@/lib/dashboard/health";
import { periodLabel } from "@/lib/dashboard/range";

type Data<T extends WidgetData["type"]> = Extract<WidgetData, { type: T }>;

const TONE: Record<Standing, BadgeTone> = { good: "good", watch: "waiting", bad: "bad" };

/** Where a figure stands, always in words as well as colour. */
export function StandingBadge({ standing }: { standing: Standing }) {
  return <Badge tone={TONE[standing]}>{STANDING_WORDS[standing]}</Badge>;
}

const monthName = (month: string) => periodLabel(`${month}-01`, "month", true);
const runwayWords = (months: number | null) =>
  months === null ? "No limit" : `${months.toFixed(1)} months`;

function Tile({
  label,
  value,
  note,
  standing,
}: {
  label: string;
  value: string;
  note?: string;
  standing: Standing | null;
}) {
  return (
    <div className="border-border flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground text-sm">{label}</span>
        {standing && <StandingBadge standing={standing} />}
      </div>
      <span className="text-2xl leading-tight font-semibold tracking-tight">{value}</span>
      {note && <span className="text-muted-foreground text-xs">{note}</span>}
    </div>
  );
}

/** The advisor's tiles and its notes: what's going well, what to watch, what to do. */
export function HealthCheck({
  data,
  currency,
  linesHref,
}: {
  data: Data<"health_check">;
  currency: string;
  linesHref: string;
}) {
  const money = (cents: number) => formatMoney(cents / 100, currency);
  const group = (tone: "win" | "watch" | "action") => data.notes.filter((n) => n.tone === tone);
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Cash runway"
          value={data.runway ? runwayWords(data.runway.months) : "—"}
          standing={data.runway?.standing ?? null}
          note={
            data.runway
              ? data.runway.burn.cents > 0
                ? `${money(data.runway.burn.cents)} a month going out`
                : `${money(-data.runway.burn.cents)} a month more coming in`
              : "Needs your balance sheet and a full month in the books"
          }
        />
        <Tile
          label={`Revenue growth, ${data.growth?.window ?? 3} months on the ${data.growth?.window ?? 3} before`}
          value={data.growth ? formatPercent(data.growth.value) : "—"}
          standing={data.growth?.standing ?? null}
          note={data.growth ? undefined : "Needs more complete months in the books"}
        />
        <Tile
          label="Gross margin, last 12 months"
          value={data.margin ? formatPercent(data.margin.gross) : "—"}
          standing={data.margin?.standing ?? null}
          note={
            data.margin?.operating !== null && data.margin?.operating !== undefined
              ? `Operating margin ${formatPercent(data.margin.operating)}`
              : undefined
          }
        />
        <Tile
          label="Biggest line's share"
          value={data.concentration ? formatPercent(data.concentration.share) : "—"}
          standing={data.concentration?.standing ?? null}
          note={
            data.concentration
              ? `From ${data.concentration.name}`
              : data.hasLines
                ? "No line revenue in these months yet"
                : undefined
          }
        />
      </div>
      {data.debt && (
        // Owners and admins only: nobody else is handed a debt to show.
        <div className="grid gap-3 sm:grid-cols-2">
          <Tile
            label="What you owe, against a year's revenue"
            value={data.debt.toRevenue ? formatPercent(data.debt.toRevenue.share) : "—"}
            standing={data.debt.toRevenue?.standing ?? null}
            note={
              data.debt.toRevenue
                ? `${money(data.debt.owed)} owed on ${money(data.debt.toRevenue.revenue)} of revenue`
                : "Needs complete months of revenue in the books"
            }
          />
          <Tile
            label="Profit covering the debt payments"
            value={
              data.debt.coverage.times === null
                ? "Nothing due"
                : `${data.debt.coverage.times.toFixed(2)} times`
            }
            standing={data.debt.coverage.standing}
            note={`${money(data.debt.monthly)} a month in payments`}
          />
        </div>
      )}
      {!data.hasLines && (
        <p className="text-muted-foreground text-xs">
          Set up your business lines to see how much rests on one of them.{" "}
          <Link href={linesHref} className="text-foreground underline underline-offset-4">
            Business lines
          </Link>
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        <NoteList title="What's going well" notes={group("win")} empty="Nothing stands out yet." />
        <NoteList title="Things to watch" notes={group("watch")} empty="Nothing to worry about." />
        <NoteList title="Worth doing" notes={group("action")} empty="Nothing pressing." />
      </div>
      <p className="text-muted-foreground text-xs">
        From complete months in your books
        {data.through ? `, through ${monthName(data.through)}` : ""}.
        {data.partial ? ` ${monthName(data.partial)} is still being booked, so it's left out.` : ""}{" "}
        Operating figures leave out other income and other expenses (one-offs and gains).
      </p>
    </div>
  );
}

function NoteList({
  title,
  notes,
  empty,
}: {
  title: string;
  notes: { key: string; text: string }[];
  empty: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {notes.length === 0 ? (
        <p className="text-muted-foreground text-sm">{empty}</p>
      ) : (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {notes.map((note) => (
            <li key={note.key}>{note.text}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Runway({ data, currency }: { data: Data<"runway">; currency: string }) {
  const money = (cents: number) => formatMoney(cents / 100, currency);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <StatTile
          label="Runway"
          value={data.burn ? runwayWords(data.months) : "—"}
          note={
            data.burn
              ? data.burn.cents > 0
                ? `At ${money(data.burn.cents)} a month going out`
                : "Cash is growing, so it isn't running down"
              : "Needs a complete month in the books"
          }
        />
        {data.standing && <StandingBadge standing={data.standing} />}
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Cash in the bank</dt>
          <dd className="font-medium tabular-nums">{money(data.cash)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Monthly burn</dt>
          <dd className="font-medium tabular-nums">{data.burn ? money(data.burn.cents) : "—"}</dd>
        </div>
      </dl>
      {data.accounts.length > 0 && (
        <details className="text-sm">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
            {data.accounts.length === 1
              ? "1 bank account"
              : `${data.accounts.length} bank accounts`}
          </summary>
          <table className="mt-2 w-full text-left tabular-nums">
            <caption className="sr-only">Cash in each bank account</caption>
            <tbody>
              {data.accounts.map((account) => (
                <tr key={account.name} className="border-border border-b last:border-0">
                  <th scope="row" className="py-1.5 pr-3 font-normal">
                    {account.name}
                  </th>
                  <td className="py-1.5 text-right">{money(account.cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <p className="text-muted-foreground text-xs">
        {data.burn?.source === "cash_flow"
          ? `Burn is the average cash going out of running the business over ${data.burn.months.length === 1 ? "the last complete month" : `the last ${data.burn.months.length} complete months`}, from your cash flow statement.`
          : data.burn
            ? "Burn is average expenses less average revenue from your profit and loss, as your books have no cash flow statement yet."
            : ""}{" "}
        Cash counts your bank accounts only, never what you&apos;re owed or stock.
      </p>
    </div>
  );
}

export function RevenueGrowth({
  data,
  currency,
}: {
  data: Data<"revenue_growth">;
  currency: string;
}) {
  const money = (cents: number) => formatMoney(cents / 100, currency);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <StatTile
          label={`The last ${data.window} months on the ${data.window} before`}
          value={data.growth === null ? "—" : formatPercent(data.growth)}
          note={
            data.growth === null
              ? `Needs ${data.window * 2} complete months in your books`
              : `${money(data.recentAverage)} a month, from ${money(data.priorAverage)}`
          }
        />
        {data.standing && <StandingBadge standing={data.standing} />}
      </div>
      {data.points.length > 0 && (
        <TimeChart
          {...prepareTimeChart(data.points, "money", currency)}
          variant="column"
          valueLabel="Revenue in your books"
          plotHeight={140}
        />
      )}
    </div>
  );
}

export function CashFlow({ data, currency }: { data: Data<"cash_flow">; currency: string }) {
  const money = (cents: number) => formatMoney(cents / 100, currency);
  const total = (pick: (m: Data<"cash_flow">["months"][number]) => number) =>
    data.months.reduce((sum, m) => sum + pick(m), 0);
  return (
    <div className="flex flex-col gap-4">
      <TimeChart
        {...prepareTimeChart(data.points, "money", currency)}
        variant="column"
        valueLabel="Net change in cash"
      />
      {data.months.length > 0 && (
        <details className="text-sm">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
            See where it came from and went, month by month
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-right tabular-nums">
              <caption className="sr-only">Cash flow by month</caption>
              <thead className="text-muted-foreground text-xs">
                <tr className="border-border border-b">
                  <th scope="col" className="py-2 pr-3 text-left font-medium">
                    Month
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Running the business
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Equipment and investments
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Loans and owner&apos;s money
                  </th>
                  <th scope="col" className="py-2 pl-2 font-medium">
                    Net change
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.months.map((m) => (
                  <tr key={m.key} className="border-border border-b last:border-0">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      {m.label}
                    </th>
                    <td className="px-2 py-2">{money(m.operating)}</td>
                    <td className="px-2 py-2">{money(m.investing)}</td>
                    <td className="px-2 py-2">{money(m.financing)}</td>
                    <td className="py-2 pl-2 font-medium">{money(m.net)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-border border-t">
                  <th scope="row" className="py-2 pr-3 text-left font-medium">
                    All months
                  </th>
                  <td className="px-2 py-2">{money(total((m) => m.operating))}</td>
                  <td className="px-2 py-2">{money(total((m) => m.investing))}</td>
                  <td className="px-2 py-2">{money(total((m) => m.financing))}</td>
                  <td className="py-2 pl-2 font-medium">{money(total((m) => m.net))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

export function OperatingProfit({
  data,
  currency,
}: {
  data: Data<"operating_profit">;
  currency: string;
}) {
  const money = (cents: number) => formatMoney(cents / 100, currency);
  const leftOut = [
    data.otherIncome ? `${money(data.otherIncome)} of other income` : null,
    data.otherExpenses ? `${money(data.otherExpenses)} of other expenses` : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-4">
      <TimeChart
        {...prepareTimeChart(data.points, "money", currency)}
        variant="column"
        valueLabel="Operating profit"
      />
      <ul className="text-muted-foreground flex flex-col gap-1 text-xs">
        {leftOut.length > 0 && <li>Left out as one-offs and gains: {leftOut.join(" and ")}.</li>}
        {data.partial && (
          <li>{monthName(data.partial)} is still being booked, so its figure will move.</li>
        )}
      </ul>
    </div>
  );
}
