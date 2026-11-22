import { formatMoney } from "@/lib/dashboard/format";

export type BarRow = { name: string; value: number; detail?: string };

/**
 * Ranked bars: a name, an aligned bar and a figure per row. Used for
 * comparing parts with each other (products, channels, how late invoices
 * are). One colour, because the rows are one series; the names carry identity.
 */
export function BarList({
  rows,
  currency,
  emptyText,
}: {
  rows: BarRow[];
  currency: string;
  emptyText: string;
}) {
  if (rows.length === 0) return <p className="text-muted-foreground text-sm">{emptyText}</p>;
  const max = Math.max(...rows.map((row) => row.value), 0);
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li
          key={row.name}
          className="group grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1"
        >
          <span className="truncate text-sm" title={row.name}>
            {row.name}
            {row.detail && <span className="text-muted-foreground"> · {row.detail}</span>}
          </span>
          <span className="text-sm font-medium tabular-nums">
            {formatMoney(row.value, currency, false, max >= 100)}
          </span>
          <span className="bg-muted col-span-2 block h-2 rounded-r-sm" aria-hidden>
            <span
              className="bg-chart-1 block h-2 rounded-r-sm transition-opacity group-hover:opacity-80"
              style={{ width: `${max > 0 ? Math.max(0, (row.value / max) * 100) : 0}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}
