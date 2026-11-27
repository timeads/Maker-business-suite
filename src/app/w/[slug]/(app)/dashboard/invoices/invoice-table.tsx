"use client";

import { useState, useTransition } from "react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Select } from "@/components/ui/input";
import { customerChoice } from "@/lib/dashboard/book-revenue";
import { formatMoney } from "@/lib/dashboard/format";
import {
  STATUS_WORDS,
  daysLate,
  type InvoiceSortChoice,
  type InvoiceStatus,
  type PlaceWords,
} from "@/lib/dashboard/invoices";
import type { BookAccountChoice, BooksRevenue } from "@/lib/dashboard/lines";
import { saveInvoiceCustomer } from "../actions";
import { SplitEditor } from "../expenses/expense-inbox";
import { sortInvoices } from "../invoice-actions";
import type { InvoiceRow } from "./data";

type Line = { id: string; name: string };
type State = { error?: string; message?: string };

const STATUS_TONE: Record<InvoiceStatus, BadgeTone> = {
  paid: "good",
  open: "open",
  overdue: "bad",
};
const PLACE_TONE: Record<PlaceWords["state"], BadgeTone> = {
  sorted: "good",
  waiting: "waiting",
  left_out: "closed",
};

const shortDay = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );

/** A picker's value as a choice for the invoice; "split" opens the split editor. */
function choiceOf(value: string): InvoiceSortChoice | "split" | null {
  if (value.startsWith("line:")) return { sort: "line", line: value.slice(5) };
  if (value === "split") return "split";
  if (value === "shop" || value === "left_out" || value === "none") return { sort: value };
  return null;
}

/** A picker's customer value ("cust:…") as that customer's default; null takes it away. */
function customerOf(value: string): BookAccountChoice | null | undefined {
  if (!value.startsWith("cust:")) return undefined;
  const rest = value.slice(5);
  if (rest === "none") return null;
  if (rest.startsWith("line:")) return { line: rest.slice(5) };
  if (rest === "skip:shop" || rest === "skip:other") {
    return { skip: rest.slice(5) as "shop" | "other" };
  }
  return undefined;
}

/**
 * Money → Invoices' table: each invoice's line, where it counts and why, a
 * picker on each row that saves at once, and tick boxes to put several in
 * the same place. Every change goes through a server action; nothing is
 * decided in the browser.
 */
export function InvoiceTable({
  slug,
  rows,
  lines,
  customers,
  currency,
  today,
  canEdit,
}: {
  slug: string;
  rows: InvoiceRow[];
  lines: Line[];
  customers: BooksRevenue["customers"];
  currency: string;
  today: string;
  canEdit: boolean;
}) {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [splitFor, setSplitFor] = useState<string[] | null>(null);
  const [state, setState] = useState<State>({});
  const [pending, start] = useTransition();
  const money = (cents: number) => formatMoney(cents / 100, currency);

  const run = (work: () => Promise<State>, after?: () => void) =>
    start(async () => {
      const result = await work();
      setState(result);
      if (!result.error) after?.();
    });
  const sortThese = (ids: string[], choice: InvoiceSortChoice) =>
    run(
      () => sortInvoices(slug, ids, choice),
      () => {
        setTicked(new Set());
        setSplitFor(null);
      },
    );

  const choose = (ids: string[], value: string, row?: InvoiceRow) => {
    const forCustomer = customerOf(value);
    if (forCustomer !== undefined && row?.customer) {
      const who = { ref: row.customer_ref, name: row.customer };
      return run(() => saveInvoiceCustomer(slug, who, forCustomer));
    }
    const choice = choiceOf(value);
    if (choice === "split") return setSplitFor(ids);
    if (choice) sortThese(ids, choice);
  };

  const options = (row: InvoiceRow | null) => {
    const chosen = row?.sort ?? null;
    const forCustomer =
      row?.customer && lines.length > 0
        ? customerChoice({ customers }, { ref: row.customer_ref, name: row.customer })
        : null;
    return (
      <>
        <option value="">
          {row ? (chosen ? "Change to…" : "Put in…") : "Put the ticked ones in…"}
        </option>
        {lines.map((line) => (
          <option key={line.id} value={`line:${line.id}`}>
            {line.name}
          </option>
        ))}
        {lines.length >= 2 && <option value="split">Split across lines…</option>}
        <option value="shop">Already counted by my shop</option>
        <option value="left_out">Leave it out</option>
        {(!row || chosen) && (
          <option value="none">Let its customer or income account decide</option>
        )}
        {row?.customer && lines.length > 0 && (
          <optgroup label="Always put this customer's invoices in…">
            {lines.map((line) => (
              <option key={line.id} value={`cust:line:${line.id}`}>
                {line.name}, every time
              </option>
            ))}
            <option value="cust:skip:shop">Already counted by my shop, every time</option>
            <option value="cust:skip:other">Leave them out, every time</option>
            {forCustomer && <option value="cust:none">Stop choosing for this customer</option>}
          </optgroup>
        )}
      </>
    );
  };

  const toggle = (id: string) => {
    const next = new Set(ticked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTicked(next);
  };
  const tickedIds = [...ticked];
  const allTicked = rows.length > 0 && rows.every((row) => ticked.has(row.id));

  return (
    <div className="flex flex-col gap-3">
      {canEdit && tickedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" aria-busy={pending}>
          <span className="text-sm font-medium">{tickedIds.length} ticked</span>
          <label htmlFor="invoices-bulk" className="sr-only">
            Where the ticked invoices go
          </label>
          <Select
            id="invoices-bulk"
            value=""
            disabled={pending}
            className="sm:w-64"
            onChange={(event) => choose(tickedIds, event.target.value)}
          >
            {options(null)}
          </Select>
          <Button type="button" variant="ghost" size="sm" onClick={() => setTicked(new Set())}>
            Untick all
          </Button>
        </div>
      )}
      {pending && (
        <p className="text-muted-foreground text-sm" role="status">
          Saving…
        </p>
      )}
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      {splitFor && (
        <SplitEditor
          lines={lines}
          count={splitFor.length}
          disabled={pending}
          noun={["invoice", "invoices"]}
          onCancel={() => setSplitFor(null)}
          onSave={(split) => sortThese(splitFor, { sort: "split", split })}
        />
      )}

      <div className="bg-card overflow-x-auto rounded-md border">
        <table className="w-full min-w-[52rem] text-sm">
          <caption className="sr-only">Invoices from your books</caption>
          <thead className="text-muted-foreground text-xs">
            <tr className="border-border border-b text-left">
              {canEdit && (
                <th scope="col" className="w-8 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allTicked}
                    onChange={() =>
                      setTicked(allTicked ? new Set() : new Set(rows.map((row) => row.id)))
                    }
                    aria-label="Tick every invoice on this page"
                  />
                </th>
              )}
              <th scope="col" className="px-3 py-2 font-medium">
                Number
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Customer
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Date
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Due
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Amount
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Still owed
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Line
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const label = `invoice ${row.doc_number ?? ""} to ${row.customer ?? "no customer"}, ${shortDay(row.txn_date)}`;
              return (
                <tr key={row.id} className="border-border border-b align-top last:border-0">
                  {canEdit && (
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={ticked.has(row.id)}
                        onChange={() => toggle(row.id)}
                        aria-label={`Tick ${label}`}
                      />
                    </td>
                  )}
                  <td className="px-3 py-2 tabular-nums">{row.doc_number ?? "–"}</td>
                  <td className="font-read px-3 py-2">{row.customer ?? "–"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{shortDay(row.txn_date)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {row.due_date ? shortDay(row.due_date) : "–"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(row.total_cents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.balance_cents > 0 ? money(row.balance_cents) : "–"}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_TONE[row.status]}>
                      {row.status === "overdue"
                        ? `${STATUS_WORDS.overdue}, ${daysLate(row.due_date, today)} days`
                        : STATUS_WORDS[row.status]}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex min-w-48 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Badge tone={PLACE_TONE[row.place.state]}>{row.place.line}</Badge>
                        <span className="text-muted-foreground text-xs">
                          {row.place.why.toLowerCase()}
                        </span>
                      </span>
                      <details className="text-xs">
                        <summary className="text-muted-foreground w-fit cursor-pointer hover:underline">
                          Why?
                        </summary>
                        <div className="font-read text-text-2 mt-1 flex max-w-prose flex-col gap-1">
                          {row.why.map((sentence) => (
                            <p key={sentence}>{sentence}</p>
                          ))}
                        </div>
                      </details>
                      {canEdit && (
                        <>
                          <label htmlFor={`line-${row.id}`} className="sr-only">
                            Which line {label} goes in
                          </label>
                          <Select
                            id={`line-${row.id}`}
                            value=""
                            disabled={pending}
                            className="h-8 text-xs"
                            onChange={(event) => choose([row.id], event.target.value, row)}
                          >
                            {options(row)}
                          </Select>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
