"use client";

import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/dashboard/format";
import { cn } from "@/lib/utils";

export type SpendItem = {
  sku: string | null;
  title: string;
  supplierName: string;
  units: number;
  /** "1234.50" */
  spend: string;
  poCount: number;
  /** YYYY-MM-DD */
  lastOrdered: string;
  /** The same day in words, written on the server so both sides agree. */
  lastOrderedText: string;
};

const COLUMNS = [
  { key: "title", label: "Item", numeric: false },
  { key: "supplierName", label: "Supplier", numeric: false },
  { key: "units", label: "Units", numeric: true },
  { key: "poCount", label: "Orders", numeric: true },
  { key: "lastOrdered", label: "Last ordered", numeric: false },
  { key: "spend", label: "Spent", numeric: true },
] as const;
type SortKey = (typeof COLUMNS)[number]["key"];

const SHOWN = 200;
const csvCell = (value: string | number) => {
  const text = String(value);
  // A cell that starts like a formula is given a leading quote mark, so a
  // spreadsheet reads it as words.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * What was spent on each item, searched and re-sorted in the browser (the
 * rows are already here). The spreadsheet holds every row the search leaves,
 * in the order on screen.
 */
export function SpendItemsTable({
  items,
  currency,
  rangeLabel,
}: {
  items: SpendItem[];
  currency: string;
  rangeLabel: string;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "spend", desc: true });
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = needle
      ? items.filter((item) =>
          `${item.sku ?? ""} ${item.title} ${item.supplierName}`.toLowerCase().includes(needle),
        )
      : items;
    const sign = sort.desc ? -1 : 1;
    return [...rows].sort((a, b) => {
      const by =
        sort.key === "spend"
          ? Number(a.spend) - Number(b.spend)
          : sort.key === "units" || sort.key === "poCount"
            ? a[sort.key] - b[sort.key]
            : a[sort.key].localeCompare(b[sort.key], "en", { sensitivity: "base" });
      return sign * by || a.title.localeCompare(b.title);
    });
  }, [items, q, sort]);
  const total = filtered.reduce((cents, item) => cents + Math.round(Number(item.spend) * 100), 0);
  const money = (value: number) => formatMoney(value, currency);

  function download() {
    const lines = [
      ["SKU", "Item", "Supplier", "Units", "Spent", "Orders", "Last ordered"],
      ...filtered.map((item) => [
        item.sku ?? "",
        item.title,
        item.supplierName,
        item.units,
        item.spend,
        item.poCount,
        item.lastOrdered,
      ]),
    ];
    const blob = new Blob([lines.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n"], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `spend-by-item-${rangeLabel}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Input
          type="search"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Search item, SKU or supplier…"
          aria-label="Search what was spent by item"
          className="h-[30px] w-full max-w-xs text-sm"
        />
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <Download /> Export CSV
        </Button>
        <span className="text-muted-foreground text-xs tabular-nums" aria-live="polite">
          {filtered.length} item{filtered.length === 1 ? "" : "s"} ·{" "}
          <span className="text-foreground font-semibold">{money(total / 100)}</span>
          {q.trim() ? " in this search" : " in all"}
        </span>
      </div>
      {filtered.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing matches.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-muted-foreground text-xs">
              <tr>
                {COLUMNS.map((column) => {
                  const active = sort.key === column.key;
                  return (
                    <th
                      key={column.key}
                      aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}
                      className={cn("py-2 pr-3 font-semibold", column.numeric && "text-right")}
                    >
                      <button
                        type="button"
                        className={cn("hover:text-foreground", active && "text-foreground")}
                        onClick={() =>
                          setSort((now) =>
                            now.key === column.key
                              ? { key: column.key, desc: !now.desc }
                              : { key: column.key, desc: column.numeric },
                          )
                        }
                      >
                        {column.label}
                        {active && <span aria-hidden> {sort.desc ? "▼" : "▲"}</span>}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-border divide-y tabular-nums">
              {filtered.slice(0, SHOWN).map((item) => (
                <tr key={`${item.sku ?? `title:${item.title}`}|${item.supplierName}`}>
                  <td className="py-2 pr-3">
                    <span className="font-read">{item.title}</span>
                    {item.sku && (
                      <span className="text-muted-foreground block text-xs">{item.sku}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">{item.supplierName}</td>
                  <td className="py-2 pr-3 text-right">{item.units.toLocaleString("en-US")}</td>
                  <td className="py-2 pr-3 text-right">{item.poCount}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{item.lastOrderedText}</td>
                  <td className="py-2 pr-3 text-right">{money(Number(item.spend))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {filtered.length > SHOWN && (
        <p className="text-muted-foreground text-xs">
          Showing the first {SHOWN} of {filtered.length}. Search to narrow it down, or export the
          lot.
        </p>
      )}
    </div>
  );
}
