"use client";

import { expenseSortExplained } from "@/lib/dashboard/explain";
import Link from "next/link";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Select } from "@/components/ui/input";
import { formatMoney } from "@/lib/dashboard/format";
import { actionWords, type SortAction } from "@/lib/dashboard/expenses";
import {
  applyRulesToWaiting,
  sortExpenses,
  suggestLines,
  type ExpenseActionState,
} from "../expense-actions";

export type InboxRow = {
  id: string;
  kind: string;
  payment_type: string | null;
  txn_date: string;
  amount_cents: number | string;
  account: string | null;
  payee: string | null;
  memo: string;
  lines: { account: string | null; amount_cents: number; description: string }[] | null;
  sort: SortAction["sort"] | null;
  line_id: string | null;
  split: Record<string, number> | null;
  sorted_by: "person" | "rule" | "vendor" | "account" | null;
  suggested: {
    sort: SortAction["sort"];
    line?: string;
    split?: Record<string, number>;
    source: "rule" | "vendor" | "ai";
    reason?: string;
    sure?: "high" | "low";
  } | null;
};

type Line = { id: string; name: string };

const KIND_WORDS: Record<string, string> = {
  bill: "Bill",
  journal: "Journal entry",
  purchase: "Purchase",
};
const PAYMENT_WORDS: Record<string, string> = {
  CreditCard: "Card",
  Check: "Cheque",
  Cash: "Cash",
};

const dayWords = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));

/** The row's sorting as an action, or null when it's still to sort. */
function rowAction(row: InboxRow): SortAction | null {
  switch (row.sort) {
    case "line":
      return row.line_id ? { sort: "line", line: row.line_id } : null;
    case "split":
      return row.split ? { sort: "split", split: row.split } : null;
    case "shared":
      return { sort: "shared" };
    case "set_aside":
      return { sort: "set_aside" };
    default:
      return null;
  }
}

function suggestionAction(s: NonNullable<InboxRow["suggested"]>): SortAction | null {
  if (s.sort === "line" && s.line) return { sort: "line", line: s.line };
  if (s.sort === "split" && s.split) return { sort: "split", split: s.split };
  if (s.sort === "shared") return { sort: "shared" };
  if (s.sort === "set_aside") return { sort: "set_aside" };
  return null;
}

const SOURCE_WORDS = {
  rule: "your rule",
  vendor: "your payee default",
  account: "its account in your books",
  ai: "Claude",
} as const;

/**
 * The inbox's rows, with ticking, a choice per row or for the ticked ones,
 * suggestions beside each expense, and the two presses that look for
 * suggestions. Every change goes through a server action; nothing is sorted
 * in the browser.
 */
export function ExpenseInbox({
  slug,
  rows,
  lines,
  currency,
  canEdit,
  aiReady,
  rulesHref,
}: {
  slug: string;
  rows: InboxRow[];
  lines: Line[];
  currency: string;
  canEdit: boolean;
  aiReady: boolean;
  rulesHref: string;
}) {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [splitFor, setSplitFor] = useState<string[] | null>(null);
  const [state, setState] = useState<ExpenseActionState>({});
  const [pending, start] = useTransition();
  const lineName = (id: string) => lines.find((line) => line.id === id)?.name ?? "a removed line";
  const unsorted = rows.filter((row) => row.sort === null);

  const run = (work: () => Promise<ExpenseActionState>, after?: () => void) =>
    start(async () => {
      const result = await work();
      setState(result);
      if (!result.error) after?.();
    });
  const sortThese = (ids: string[], choice: SortAction | { sort: "none" }) =>
    run(
      () => sortExpenses(slug, ids, choice),
      () => {
        setTicked(new Set());
        setSplitFor(null);
      },
    );

  const choose = (ids: string[], value: string) => {
    if (!value) return;
    if (value === "split") return setSplitFor(ids);
    if (value === "none") return sortThese(ids, { sort: "none" });
    if (value === "shared" || value === "set_aside") return sortThese(ids, { sort: value });
    if (value.startsWith("line:")) sortThese(ids, { sort: "line", line: value.slice(5) });
  };

  const choices = (current: SortAction | null) => (
    <>
      <option value="">{current ? "Change to…" : "Put on…"}</option>
      {lines.map((line) => (
        <option key={line.id} value={`line:${line.id}`}>
          {line.name}
        </option>
      ))}
      {lines.length >= 2 && <option value="split">Split across lines…</option>}
      <option value="shared">Shared across lines</option>
      <option value="set_aside">Not a business expense</option>
      {current && <option value="none">Put back in the inbox</option>}
    </>
  );

  const toggle = (id: string) => {
    const next = new Set(ticked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTicked(next);
  };
  const tickedIds = [...ticked];

  return (
    <div className="flex flex-col gap-3">
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2" aria-busy={pending}>
          {tickedIds.length > 0 ? (
            <>
              <span className="text-sm font-medium">{tickedIds.length} ticked</span>
              <label htmlFor="bulk-choice" className="sr-only">
                Where the ticked expenses go
              </label>
              <Select
                id="bulk-choice"
                value=""
                disabled={pending}
                className="sm:w-56"
                onChange={(event) => choose(tickedIds, event.target.value)}
              >
                {choices({ sort: "shared" })}
              </Select>
              {aiReady && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => run(() => suggestLines(slug, tickedIds))}
                >
                  Suggest lines for these
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={() => setTicked(new Set())}>
                Untick all
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => run(() => applyRulesToWaiting(slug))}
              >
                Apply my rules to what&apos;s waiting
              </Button>
              {aiReady && unsorted.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    run(() =>
                      suggestLines(
                        slug,
                        unsorted.map((row) => row.id),
                      ),
                    )
                  }
                >
                  Suggest lines for these {Math.min(unsorted.length, 40)}
                </Button>
              )}
              <Link
                href={rulesHref}
                className="text-muted-foreground text-xs underline underline-offset-4"
              >
                Payee defaults and rules
              </Link>
            </>
          )}
        </div>
      )}

      {pending && (
        <p className="text-muted-foreground text-sm" role="status">
          Working on it…
        </p>
      )}
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>

      {splitFor && (
        <SplitEditor
          lines={lines}
          count={splitFor.length}
          disabled={pending}
          onCancel={() => setSplitFor(null)}
          onSave={(split) => sortThese(splitFor, { sort: "split", split })}
        />
      )}

      <ul className="border-border bg-card divide-border divide-y rounded-md border">
        {rows.map((row) => {
          const current = rowAction(row);
          const suggestion = row.suggested ? suggestionAction(row.suggested) : null;
          const details = (row.lines ?? [])
            .map((line) => line.description)
            .filter(Boolean)
            .join(" · ");
          const who = row.payee ?? (details || row.account || "No payee in the books");
          return (
            <li key={row.id} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start">
              {canEdit && (
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={ticked.has(row.id)}
                  onChange={() => toggle(row.id)}
                  aria-label={`Tick ${who}, ${dayWords(row.txn_date)}`}
                />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="truncate font-medium" title={who}>
                    {who}
                  </span>
                  <span className="font-medium tabular-nums">
                    {formatMoney(Number(row.amount_cents) / 100, currency)}
                  </span>
                </div>
                <p className="text-muted-foreground text-xs">
                  {dayWords(row.txn_date)} ·{" "}
                  {(row.payment_type && PAYMENT_WORDS[row.payment_type]) ??
                    KIND_WORDS[row.kind] ??
                    row.kind}
                  {row.account && ` · ${row.account}`}
                  {row.memo && ` · ${row.memo}`}
                  {row.payee && details && ` · ${details}`}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {current ? (
                    <Badge tone={current.sort === "set_aside" ? "closed" : "good"}>
                      {actionWords(current, lineName)}
                    </Badge>
                  ) : (
                    <Badge tone="waiting">To sort</Badge>
                  )}
                  {current && row.sorted_by && row.sorted_by !== "person" && (
                    <span className="text-muted-foreground text-xs">
                      by {SOURCE_WORDS[row.sorted_by]}
                    </span>
                  )}
                  {current && (
                    <details className="text-xs">
                      <summary className="text-muted-foreground cursor-pointer hover:underline">
                        Why?
                      </summary>
                      <p className="font-read text-text-2 mt-1 max-w-prose">
                        {expenseSortExplained(row.sorted_by, current, lineName)}
                      </p>
                    </details>
                  )}
                  {!current && suggestion && row.suggested && (
                    <span className="flex flex-wrap items-center gap-2 text-xs">
                      <span>
                        Suggested: <strong>{actionWords(suggestion, lineName)}</strong>
                        <span className="text-muted-foreground">
                          {" "}
                          ({SOURCE_WORDS[row.suggested.source]}
                          {row.suggested.sure === "low" ? ", not sure" : ""}
                          {row.suggested.reason ? `: ${row.suggested.reason}` : ""})
                        </span>
                      </span>
                      {canEdit && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => sortThese([row.id], suggestion)}
                        >
                          Use this
                        </Button>
                      )}
                    </span>
                  )}
                </div>
              </div>
              {canEdit && (
                <div className="sm:w-52 sm:shrink-0">
                  <label htmlFor={`choice-${row.id}`} className="sr-only">
                    Where {who} goes
                  </label>
                  <Select
                    id={`choice-${row.id}`}
                    value=""
                    disabled={pending}
                    onChange={(event) => choose([row.id], event.target.value)}
                  >
                    {choices(current)}
                  </Select>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Whole percents per line, saved only once they add up to 100 over two lines or more. */
export function SplitEditor({
  lines,
  count,
  disabled,
  onSave,
  onCancel,
  noun = ["expense", "expenses"],
}: {
  lines: Line[];
  count: number;
  disabled: boolean;
  onSave: (split: Record<string, number>) => void;
  onCancel: () => void;
  /** What is being split, one and many. */
  noun?: readonly [string, string];
}) {
  const [shares, setShares] = useState<Record<string, number>>({});
  const used = Object.entries(shares).filter(([, pct]) => pct > 0);
  const total = used.reduce((sum, [, pct]) => sum + pct, 0);
  const ready = used.length >= 2 && total === 100;
  return (
    <fieldset className="border-border bg-card flex flex-col gap-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-semibold">
        Split {count === 1 ? `this ${noun[0]}` : `${count} ${noun[1]}`} across your lines
      </legend>
      <div className="flex flex-wrap gap-3">
        {lines.map((line) => (
          <label key={line.id} className="flex flex-col gap-1 text-sm">
            {line.name}
            <span className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                inputMode="numeric"
                value={shares[line.id] ?? ""}
                onChange={(event) => {
                  const value = Math.max(
                    0,
                    Math.min(100, Math.round(Number(event.target.value) || 0)),
                  );
                  setShares({ ...shares, [line.id]: value });
                }}
                className="border-input bg-card h-9 w-20 rounded-sm border px-2 text-sm tabular-nums"
              />
              %
            </span>
          </label>
        ))}
      </div>
      <p className={ready ? "text-sm" : "text-muted-foreground text-sm"} role="status">
        {total}% of 100%
        {used.length < 2 && " · a split needs at least two lines"}
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!ready || disabled}
          onClick={() => onSave(Object.fromEntries(used))}
        >
          Save the split
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}
