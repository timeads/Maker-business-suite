"use client";

import { useActionState, useMemo, useState, useSyncExternalStore, useTransition } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { Download, Pencil, SlidersHorizontal } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { formatMoney } from "@/lib/dashboard/format";
import {
  COLUMNS,
  COLUMNS_ADDED_LATER,
  DEFAULT_HIDDEN_COLUMNS,
  EDITABLE_COLUMNS,
  isColumnKey,
  type ColumnKey,
  type GridRow,
  type SortDir,
} from "@/lib/stock/views";
import { cn } from "@/lib/utils";
import { bulkItems, saveItemFigure, type FigureField } from "../actions";
import { RequestKey, Result } from "../forms";

const TONES: Record<GridRow["health"], BadgeTone> = {
  out: "bad",
  under: "waiting",
  healthy: "good",
  over: "open",
  nosales: "closed",
};

// Which columns this viewer has switched off. Kept in the browser as a
// convenience only: if storage is blocked the choice lasts until the page is
// left, and the grid works the same either way.
const STORE = "stock.items.columns.v1";
const CHANGED = "stock-columns-changed";
let memory: string | null = null;
const subscribe = (notify: () => void) => {
  window.addEventListener("storage", notify);
  window.addEventListener(CHANGED, notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener(CHANGED, notify);
  };
};
const readStore = () => {
  if (memory !== null) return memory;
  try {
    return window.localStorage.getItem(STORE) ?? "";
  } catch {
    return "";
  }
};
function writeStore(hidden: ColumnKey[]) {
  // `seen` marks a choice made with every column of today's grid on offer.
  memory = JSON.stringify({ hidden, seen: COLUMNS.map((column) => column.key) });
  try {
    window.localStorage.setItem(STORE, memory);
  } catch {
    // Private window or blocked storage: the choice still holds for this visit.
  }
  window.dispatchEvent(new Event(CHANGED));
}
function parseHidden(raw: string): ColumnKey[] {
  if (!raw) return DEFAULT_HIDDEN_COLUMNS;
  try {
    const value: unknown = JSON.parse(raw);
    const keys = (list: unknown) =>
      Array.isArray(list) ? list.filter(isColumnKey).filter((k) => k !== "item") : [];
    // The first format was a bare list, saved before some columns existed.
    if (Array.isArray(value)) return [...new Set([...keys(value), ...COLUMNS_ADDED_LATER])];
    if (!value || typeof value !== "object") return DEFAULT_HIDDEN_COLUMNS;
    const saved = value as { hidden?: unknown; seen?: unknown };
    const seen = new Set<ColumnKey>(keys(saved.seen));
    // A column that came along after this choice was saved starts as it does for everyone.
    const unseen = DEFAULT_HIDDEN_COLUMNS.filter((key) => !seen.has(key));
    return [...new Set([...keys(saved.hidden), ...unseen])];
  } catch {
    return DEFAULT_HIDDEN_COLUMNS;
  }
}

/** A button on the bar. The one that was pressed shows its own "working" words. */
function DoButton({
  value,
  pendingText,
  disabled,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { value: string; pendingText: string }) {
  const { pending, data } = useFormStatus();
  return (
    <Button
      type="submit"
      name="do"
      value={value}
      disabled={pending || disabled}
      aria-disabled={pending || disabled}
      {...props}
    >
      {pending && data?.get("do") === value ? pendingText : children}
    </Button>
  );
}

/**
 * One planning figure, changed where it sits in the table. It saves when the
 * box is left (or Enter is pressed); the page then reads everything again, so
 * the sums beside it move too. An empty box clears the figure.
 */
function FigureBox({
  slug,
  itemId,
  field,
  value,
  placeholder,
  label,
  emptyAs = "",
}: {
  slug: string;
  itemId: string;
  field: FigureField;
  /** What's saved now, as it sits in the box ("" = nothing typed). */
  value: string;
  /** What's used while the box is empty (the supplier's figure, say). */
  placeholder: string;
  label: string;
  emptyAs?: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <Input
        defaultValue={value}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        inputMode={field === "cost" ? "decimal" : "numeric"}
        maxLength={14}
        className={cn("h-7 w-20 px-1.5 text-right text-sm", pending && "opacity-60")}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        onBlur={(event) => {
          const box = event.currentTarget;
          const typed = box.value.trim() || emptyAs;
          box.value = typed;
          if (typed === value) {
            setError(null);
            return;
          }
          start(async () => {
            const result = await saveItemFigure(slug, itemId, field, typed);
            setError(result.error ?? null);
          });
        }}
      />
      {error && (
        <span role="alert" className="text-brick max-w-36 text-right text-xs whitespace-normal">
          {error}
        </span>
      )}
    </span>
  );
}

const BULK_FIGURES = [
  ["spare", "Keep spare"],
  ["lead", "Days to arrive"],
  ["cover", "Order covers (days)"],
  ["moq", "Smallest order"],
  ["case_pack", "In a case"],
] as const;

export function ItemsGrid({
  slug,
  rows,
  canEdit,
  suppliers,
  view,
  query,
  sort,
  currency,
}: {
  slug: string;
  rows: GridRow[];
  canEdit: boolean;
  suppliers: { id: string; name: string }[];
  /** The view on screen; "hidden" swaps the bar to bringing items back. */
  view: string;
  /** The view and search as a query string, without sort ("show=under&q=wool"). */
  query: string;
  sort: { key: ColumnKey; dir: SortDir };
  currency: string;
}) {
  const base = `/w/${slug}/stock`;
  const [state, action] = useActionState(bulkItems.bind(null, slug), {});
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const stored = useSyncExternalStore(subscribe, readStore, () => "");
  const hidden = useMemo(() => new Set(parseHidden(stored)), [stored]);
  // "Change figures" turns the planning columns into boxes, and shows them
  // all while it's on, whatever the viewer usually hides.
  const [editing, setEditing] = useState(false);
  const columns = COLUMNS.filter(
    (column) => !hidden.has(column.key) || (editing && EDITABLE_COLUMNS.includes(column.key)),
  );

  // Only rows still on screen count as ticked (the list changes after an action).
  const ticked = rows.filter((row) => picked.has(row.id));
  const allTicked = rows.length > 0 && ticked.length === rows.length;
  const toggle = (id: string) =>
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleColumn = (key: ColumnKey) =>
    writeStore(hidden.has(key) ? [...hidden].filter((k) => k !== key) : [...hidden, key]);

  const href = (params: Record<string, string>) => {
    const search = new URLSearchParams(query);
    for (const [key, value] of Object.entries(params)) search.set(key, value);
    const text = search.toString();
    return text ? `?${text}` : "";
  };
  const sortHref = (key: ColumnKey) =>
    `${base}/items${href({
      sort: key,
      dir: sort.key === key && sort.dir === "asc" ? "desc" : "asc",
    })}`;
  const exportHref = `${base}/items/export${href({
    sort: sort.key,
    dir: sort.dir,
    cols: columns.map((column) => column.key).join(","),
  })}`;
  const money = (value: number | null) => (value === null ? "–" : formatMoney(value, currency));

  const box = (
    row: GridRow,
    field: FigureField,
    value: string,
    placeholder: string,
    what: string,
    emptyAs = "",
  ) => (
    <FigureBox
      // A new box whenever the saved figure changes, so it shows what was saved.
      key={`${row.id}:${field}:${value}`}
      slug={slug}
      itemId={row.id}
      field={field}
      value={value}
      placeholder={placeholder}
      label={`${what} for ${row.name}`}
      emptyAs={emptyAs}
    />
  );
  /** The box for a planning column while figures are being changed, else null. */
  const editCell = (row: GridRow, key: ColumnKey): React.ReactNode => {
    switch (key) {
      case "cost":
        return box(
          row,
          "cost",
          row.own.cost,
          row.cost === null ? "–" : row.cost.toFixed(2),
          "Your own cost",
        );
      case "lead":
        return box(row, "lead", row.own.lead, String(row.lead), "Days to arrive");
      case "cover":
        return box(row, "cover", row.own.cover, String(row.cover), "Days an order covers");
      case "spare":
        return box(row, "spare", String(row.spare), "0", "Spare to keep", "0");
      case "minimum":
        return box(
          row,
          "moq",
          row.own.moq,
          row.minimum > 1 ? String(row.minimum) : "–",
          "Smallest order",
        );
      case "casePack":
        return box(
          row,
          "case_pack",
          row.casePack === null ? "" : String(row.casePack),
          "–",
          "How many in a case",
        );
      default:
        return null;
    }
  };

  const cell = (row: GridRow, key: ColumnKey): React.ReactNode => {
    if (editing && EDITABLE_COLUMNS.includes(key)) return editCell(row, key);
    switch (key) {
      case "item":
        return (
          <>
            <Link
              href={`${base}/items/${row.id}`}
              className="font-read font-semibold hover:underline"
            >
              {row.name}
            </Link>
            {(row.sku || row.left) && (
              <span className="text-muted-foreground block text-xs">
                {[row.sku, row.left].filter(Boolean).join(" · ")}
              </span>
            )}
          </>
        );
      case "supplier":
        return row.supplier ?? <span className="text-muted-foreground">No supplier</span>;
      case "sold30":
        return row.sold30;
      case "monthly":
        return row.monthly;
      case "cost":
        return <span title={row.cost === null ? undefined : row.costFrom}>{money(row.cost)}</span>;
      case "price":
        return money(row.price);
      case "lead":
        return row.lead;
      case "cover":
        return row.cover;
      case "spare":
        return row.spare || "–";
      case "minimum":
        return row.minimum > 1 ? row.minimum : "–";
      case "casePack":
        return row.casePack ?? "–";
      case "have":
        return <span className={cn(row.have <= 0 && "text-brick font-semibold")}>{row.have}</span>;
      case "coming":
        return row.coming || "–";
      case "runsOut":
        return row.runsOut;
      case "orderBy":
        return row.overdue ? <Badge tone="bad">{row.orderBy}</Badge> : row.orderBy;
      case "suggest":
        return row.suggest > 0 ? (
          <span title={row.why}>
            <span className="font-semibold">{row.suggest}</span>
            {row.cases && (
              <span className="text-muted-foreground block text-xs whitespace-nowrap">
                {row.cases}
              </span>
            )}
          </span>
        ) : (
          <span title={row.why}>–</span>
        );
      case "health":
        return <Badge tone={TONES[row.health]}>{row.healthLabel}</Badge>;
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        {canEdit ? (
          <form action={action} className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
            <RequestKey
              resetOn={ticked
                .map((row) => row.id)
                .sort()
                .join(",")}
            />
            {ticked.map((row) => (
              <input key={row.id} type="hidden" name="item" value={row.id} />
            ))}
            {view === "hidden" ? (
              <DoButton
                value="unhide"
                variant="outline"
                pendingText="Saving…"
                disabled={ticked.length === 0}
              >
                Reorder these again
              </DoButton>
            ) : (
              <>
                {/* The one filled button: turning ticked rows into orders is what this page is for. */}
                <DoButton value="draft" pendingText="Drafting…" disabled={ticked.length === 0}>
                  Draft an order
                </DoButton>
                <DoButton
                  value="hide"
                  variant="outline"
                  pendingText="Saving…"
                  disabled={ticked.length === 0}
                >
                  Don&apos;t reorder
                </DoButton>
              </>
            )}
            <div className="flex items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bulk-supplier">Give the ticked items to</Label>
                <Select id="bulk-supplier" name="supplier" defaultValue="" className="w-48">
                  <option value="">No supplier</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
              <DoButton
                value="assign"
                variant="outline"
                pendingText="Saving…"
                disabled={ticked.length === 0}
              >
                Apply
              </DoButton>
            </div>
            {view !== "hidden" && (
              <details className="basis-full">
                <summary className="text-text-2 hover:text-foreground w-fit cursor-pointer text-xs font-semibold">
                  Set figures for the ticked items
                </summary>
                <div className="bg-panel mt-2 flex flex-wrap items-end gap-2 rounded-md p-3">
                  {BULK_FIGURES.map(([field, label]) => (
                    <div key={field} className="flex flex-col gap-1.5">
                      <Label htmlFor={`set-${field}`}>{label}</Label>
                      <Input
                        id={`set-${field}`}
                        name={`set_${field}`}
                        type="number"
                        min={field === "spare" || field === "lead" ? 0 : 1}
                        step={1}
                        placeholder="Leave as is"
                        className="w-32"
                      />
                    </div>
                  ))}
                  <DoButton
                    value="plan"
                    variant="outline"
                    pendingText="Saving…"
                    disabled={ticked.length === 0}
                  >
                    {ticked.length > 0 ? `Set for ${ticked.length}` : "Set"}
                  </DoButton>
                  <p className="text-muted-foreground basis-full text-xs">
                    Only the boxes you fill in are changed. To clear a figure, press “Change
                    figures” and empty its box in the table.
                  </p>
                </div>
              </details>
            )}
            <p className="text-muted-foreground self-center text-xs" aria-live="polite">
              {ticked.length === 0
                ? "Tick some items to draft an order for each supplier among them."
                : `${ticked.length} ticked`}
            </p>
            <div className="basis-full empty:hidden">
              <Result state={state} />
            </div>
          </form>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {canEdit && (
            <Button asChild variant="ghost" size="sm">
              <Link href={`${base}/orders#new-order`}>Empty order</Link>
            </Button>
          )}
          {canEdit && (
            <Button
              type="button"
              variant={editing ? "dark" : "outline"}
              size="sm"
              aria-pressed={editing}
              onClick={() => setEditing((now) => !now)}
            >
              <Pencil /> {editing ? "Done changing" : "Change figures"}
            </Button>
          )}
          <details className="relative">
            <summary
              className={cn(
                "border-input bg-card hover:bg-hover flex h-[30px] cursor-pointer list-none items-center gap-2 rounded-sm border px-2.5 text-xs font-semibold",
                "[&::-webkit-details-marker]:hidden",
              )}
            >
              <SlidersHorizontal className="size-4" /> Columns
            </summary>
            <div className="border-border bg-card absolute right-0 z-10 mt-1 flex w-52 flex-col gap-1.5 rounded-lg border p-3 shadow-[var(--tuft-shadow)]">
              {COLUMNS.filter((column) => column.key !== "item").map((column) => (
                <label key={column.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!hidden.has(column.key)}
                    onChange={() => toggleColumn(column.key)}
                  />
                  {column.label}
                </label>
              ))}
            </div>
          </details>
          <Button asChild variant="outline" size="sm">
            <a href={exportHref}>
              <Download /> Spreadsheet
            </a>
          </Button>
        </div>
      </div>

      {editing && (
        <p className="text-muted-foreground font-read text-sm print:hidden">
          Type in a box and move on: it saves by itself, and the sums beside it catch up. An empty
          box goes back to the supplier&apos;s own figure (shown in grey).
        </p>
      )}
      <div className="border-border bg-card overflow-x-auto rounded-xl border">
        <table className="w-full text-left text-sm">
          <thead className="text-muted-foreground bg-panel text-xs">
            <tr>
              {canEdit && (
                <th className="w-9 py-2 pl-4">
                  <input
                    type="checkbox"
                    checked={allTicked}
                    onChange={() =>
                      setPicked(allTicked ? new Set() : new Set(rows.map((row) => row.id)))
                    }
                    aria-label="Tick every item on this page"
                  />
                </th>
              )}
              {columns.map((column) => {
                const active = sort.key === column.key;
                return (
                  <th
                    key={column.key}
                    aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                    className={cn(
                      "px-3 py-2 font-semibold whitespace-nowrap first:pl-4",
                      column.numeric && "text-right",
                    )}
                  >
                    <Link
                      href={sortHref(column.key)}
                      scroll={false}
                      className={cn("hover:text-foreground", active && "text-foreground")}
                    >
                      {column.label}
                      {active && <span aria-hidden> {sort.dir === "asc" ? "↑" : "↓"}</span>}
                    </Link>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {rows.map((row) => (
              <tr
                key={row.id}
                className={cn("align-top", picked.has(row.id) && "bg-[var(--tuft-select)]")}
              >
                {canEdit && (
                  <td className="py-2.5 pl-4">
                    <input
                      type="checkbox"
                      checked={picked.has(row.id)}
                      onChange={() => toggle(row.id)}
                      aria-label={`Tick ${row.name}`}
                    />
                  </td>
                )}
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      "px-3 py-2.5 first:pl-4",
                      column.numeric && "text-right tabular-nums",
                      column.key === "item" && "max-w-md min-w-56",
                      (column.key === "runsOut" || column.key === "orderBy") && "whitespace-nowrap",
                    )}
                  >
                    {cell(row, column.key)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
