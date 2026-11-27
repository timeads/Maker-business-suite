import type { WidgetData } from "@/lib/dashboard/data";
import { formatMoney } from "@/lib/dashboard/format";

type ProfitData = Extract<WidgetData, { type: "profit_by_line" }>;

/**
 * Profit by line as a table: each step of the sum in its own column, so
 * every figure on the bars can be followed back to where it came from.
 */
export function ProfitTable({ data, currency }: { data: ProfitData; currency: string }) {
  const money = (cents: number) => formatMoney(cents / 100, currency);
  const less = (cents: number) => (cents === 0 ? "–" : `−${money(cents)}`);
  const withCogs = data.cogs === "shop_item_costs";
  const source = new Map(data.sources.map((row) => [row.id, row]));
  const withBooks = data.sources.some((row) => row.books !== 0);
  const withTyped = data.sources.some((row) => row.typed !== 0);
  const total = (pick: (row: ProfitData["rows"][number]) => number) =>
    data.rows.reduce((sum, row) => sum + pick(row), 0);
  return (
    <details className="text-sm">
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
        See each step as a table
      </summary>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[34rem] text-right tabular-nums">
          <caption className="sr-only">How each line&apos;s profit is worked out</caption>
          <thead className="text-muted-foreground text-xs">
            <tr className="border-border border-b">
              <th scope="col" className="py-2 pr-3 text-left font-medium">
                Line
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Revenue
              </th>
              {withBooks && (
                <th scope="col" className="px-2 py-2 font-medium">
                  of it from your books
                </th>
              )}
              {withTyped && (
                <th scope="col" className="px-2 py-2 font-medium">
                  of it typed in
                </th>
              )}
              {withCogs && (
                <th scope="col" className="px-2 py-2 font-medium">
                  Cost of goods
                </th>
              )}
              <th scope="col" className="px-2 py-2 font-medium">
                Its expenses
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Share of shared
              </th>
              <th scope="col" className="px-2 py-2 font-medium">
                Monthly costs
              </th>
              <th scope="col" className="py-2 pl-2 font-medium">
                Profit
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.id} className="border-border border-b last:border-0">
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  {row.name}
                </th>
                <td className="px-2 py-2">{money(row.revenue)}</td>
                {withBooks && (
                  <td className="px-2 py-2">{money(source.get(row.id)?.books ?? 0)}</td>
                )}
                {withTyped && (
                  <td className="px-2 py-2">{money(source.get(row.id)?.typed ?? 0)}</td>
                )}
                {withCogs && <td className="px-2 py-2">{less(row.cogs ?? 0)}</td>}
                <td className="px-2 py-2">{less(row.direct)}</td>
                <td className="px-2 py-2">{less(row.shared)}</td>
                <td className="px-2 py-2">{less(row.monthly)}</td>
                <td className="py-2 pl-2 font-medium">{money(row.profit)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-border border-t">
              <th scope="row" className="py-2 pr-3 text-left font-medium">
                All lines
              </th>
              <td className="px-2 py-2">{money(total((row) => row.revenue))}</td>
              {withBooks && (
                <td className="px-2 py-2">
                  {money(data.sources.reduce((sum, row) => sum + row.books, 0))}
                </td>
              )}
              {withTyped && (
                <td className="px-2 py-2">
                  {money(data.sources.reduce((sum, row) => sum + row.typed, 0))}
                </td>
              )}
              {withCogs && <td className="px-2 py-2">{less(total((row) => row.cogs ?? 0))}</td>}
              <td className="px-2 py-2">{less(total((row) => row.direct))}</td>
              <td className="px-2 py-2">{less(total((row) => row.shared))}</td>
              <td className="px-2 py-2">{less(total((row) => row.monthly))}</td>
              <td className="py-2 pl-2 font-medium">{money(data.profit)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        {withCogs
          ? "Cost of goods comes from the item costs in your shop, where an item has one. "
          : "Cost of goods is counted in the expenses you sort into each line. "}
        {data.monthlyCosts > 0
          ? "Monthly costs are the ones you set in Settings, counted by the day for part of a month."
          : "No monthly costs set yet (rent split between lines, help, your own salary)."}
      </p>
    </details>
  );
}
