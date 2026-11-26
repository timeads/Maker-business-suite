"use client";

import { useState, useTransition } from "react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import type { BudgetRow, BudgetSubject } from "@/lib/dashboard/budget";
import { formatMoney } from "@/lib/dashboard/format";
import {
  copyLastMonth,
  fillBlanks,
  fillYear,
  saveBudgets,
  type BudgetActionState,
} from "./budget-actions";

const amountText = (cents: number) => (cents === 0 ? "" : (cents / 100).toFixed(2));

/** Over, under or on, in words; over on a cost that rises with sales is good news. */
function standing(row: BudgetRow): { tone: BadgeTone; words: string } | null {
  switch (row.standing) {
    case "over":
      return row.variable
        ? { tone: "good", words: "Over: selling more" }
        : { tone: "bad", words: "Over budget" };
    case "under":
      return { tone: "good", words: "Under budget" };
    case "on":
      return { tone: "open", words: "On budget" };
    default:
      return null;
  }
}

/**
 * Budget against actual, grouped as the books group their accounts. In a
 * single month an owner or admin types budgets straight into the table;
 * longer periods are for looking only. The page gives it a key from the
 * stored budgets, so it starts afresh whenever they change.
 */
export function BudgetTable({
  slug,
  month,
  subject,
  rows,
  editable,
  single,
  currency,
  averageLabel,
}: {
  slug: string;
  month: string;
  subject: BudgetSubject;
  rows: BudgetRow[];
  editable: boolean;
  /** One month: the budget boxes can be typed in. */
  single: boolean;
  currency: string;
  averageLabel: string;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((row) => [row.key, amountText(row.budget)])),
  );
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [state, setState] = useState<BudgetActionState>({});
  const [pending, start] = useTransition();
  const money = (cents: number) => formatMoney(cents / 100, currency);
  const canType = editable && single;

  const run = (job: () => Promise<BudgetActionState>, after?: () => void) =>
    start(async () => {
      const result = await job();
      setState(result);
      if (!result.error) after?.();
    });

  const shown = rows.filter((row) => !row.hidden);
  const hidden = rows.filter((row) => row.hidden);
  const total = (pick: (row: BudgetRow) => number) =>
    shown.reduce((sum, row) => sum + pick(row), 0);

  const table = (list: BudgetRow[], caption: string) => (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-right text-sm tabular-nums">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-muted-foreground text-xs">
          <tr className="border-border border-b">
            <th scope="col" className="py-2 pr-3 text-left font-medium">
              {subject === "line" ? "Line" : "Account"}
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              {averageLabel}
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              Budget
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              Spent
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              Difference
            </th>
            <th scope="col" className="py-2 pl-2 text-left font-medium">
              <span className="sr-only">How it stands</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {(subject === "line" ? [["", list] as const] : [...groupsOf(list)]).map(
            ([group, members]) => (
              <GroupRows
                key={group || "all"}
                group={subject === "line" ? "" : group}
                members={members}
                render={(row) => {
                  const badge = standing(row);
                  return (
                    <tr key={row.key} className="border-border border-b last:border-0">
                      <th scope="row" className="py-2 pr-3 text-left font-normal">
                        <span className={subject === "account" && group !== row.name ? "pl-3" : ""}>
                          {row.name}
                        </span>
                        {row.variable && (
                          <span className="text-muted-foreground block text-xs">
                            Rises and falls with sales
                          </span>
                        )}
                      </th>
                      <td className="px-2 py-2">{row.average ? money(row.average) : "–"}</td>
                      <td className="px-2 py-2">
                        {canType && !row.hidden ? (
                          <Input
                            aria-label={`Budget for ${row.name}`}
                            inputMode="decimal"
                            className="ml-auto h-8 w-28 text-right"
                            value={values[row.key] ?? ""}
                            placeholder="–"
                            onChange={(e) => {
                              setValues((v) => ({ ...v, [row.key]: e.target.value }));
                              setChanged((c) => new Set(c).add(row.key));
                            }}
                          />
                        ) : row.budget ? (
                          money(row.budget)
                        ) : (
                          "–"
                        )}
                      </td>
                      <td className="px-2 py-2">{money(row.actual)}</td>
                      <td className="px-2 py-2">
                        {row.budget ? `${row.variance > 0 ? "+" : ""}${money(row.variance)}` : "–"}
                      </td>
                      <td className="py-2 pl-2 text-left">
                        {badge && <Badge tone={badge.tone}>{badge.words}</Badge>}
                      </td>
                    </tr>
                  );
                }}
              />
            ),
          )}
        </tbody>
        {list === shown && (
          <tfoot>
            <tr className="border-border border-t font-medium">
              <th scope="row" className="py-2 pr-3 text-left">
                All {subject === "line" ? "lines" : "accounts"}
              </th>
              <td className="px-2 py-2">{money(total((row) => row.average))}</td>
              <td className="px-2 py-2">{money(total((row) => row.budget))}</td>
              <td className="px-2 py-2">{money(total((row) => row.actual))}</td>
              <td className="px-2 py-2">{money(total((row) => row.variance))}</td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {editable && single && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => run(() => copyLastMonth(slug, month))}
          >
            Copy last month&apos;s budget
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => run(() => fillBlanks(slug, month, subject))}
          >
            Fill blanks from the average
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => run(() => fillYear(slug, month))}
          >
            Copy this month to the rest of the year
          </Button>
        </div>
      )}
      {shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Nothing spent or budgeted here yet. Expenses come from your books once QuickBooks is
          connected.
        </p>
      ) : (
        table(shown, "Budget against what was spent")
      )}
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      {canType && shown.length > 0 && (
        <Button
          className="sm:w-fit"
          variant={changed.size > 0 ? "default" : "outline"}
          disabled={pending || changed.size === 0}
          onClick={() =>
            run(
              () =>
                saveBudgets(
                  slug,
                  month,
                  subject,
                  [...changed].map((key) => ({ key, amount: values[key] ?? "" })),
                ),
              () => setChanged(new Set()),
            )
          }
        >
          {pending ? "Saving…" : "Save budget"}
        </Button>
      )}
      {!single && editable && (
        <p className="text-muted-foreground text-xs">
          Budgets add up over a longer period here. Pick a single month to change them.
        </p>
      )}
      {hidden.length > 0 && (
        <details className="text-sm">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
            Left off the budget ({hidden.length})
          </summary>
          <div className="mt-2">{table(hidden, "Accounts left off the budget")}</div>
        </details>
      )}
    </div>
  );
}

function groupsOf(rows: BudgetRow[]): Map<string, BudgetRow[]> {
  const groups = new Map<string, BudgetRow[]>();
  for (const row of rows) {
    const list = groups.get(row.group) ?? [];
    list.push(row);
    groups.set(row.group, list);
  }
  return groups;
}

/** A group's heading row (for sub-accounts) and its rows. */
function GroupRows({
  group,
  members,
  render,
}: {
  group: string;
  members: BudgetRow[];
  render: (row: BudgetRow) => React.ReactNode;
}) {
  const heading = group && (members.length > 1 || members[0].name !== group);
  return (
    <>
      {heading && (
        <tr className="border-border border-b">
          <th scope="rowgroup" colSpan={6} className="pt-3 pb-1 text-left text-xs font-semibold">
            {group}
          </th>
        </tr>
      )}
      {members.map(render)}
    </>
  );
}
