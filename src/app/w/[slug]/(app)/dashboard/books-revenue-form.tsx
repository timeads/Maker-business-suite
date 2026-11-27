"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { BookAccountChoice, BooksRevenue, BusinessLine } from "@/lib/dashboard/lines";
import { formatMoney } from "@/lib/dashboard/format";
import { removeInvoiceCustomer, saveBooksRevenue, type RevenueState } from "./actions";

export type AccountOption = {
  ref: string | null;
  name: string | null;
  invoices: number;
  cents: number;
  choice: BookAccountChoice | null;
};

const keyOf = (a: { ref: string | null; name: string | null }) =>
  a.ref ? `ref:${a.ref}` : `name:${a.name ?? ""}`;

const choiceValue = (choice: BookAccountChoice | null) =>
  !choice ? "" : "line" in choice ? `line:${choice.line}` : `skip:${choice.skip}`;

const choiceOf = (value: string): BookAccountChoice | null => {
  if (value.startsWith("line:")) return { line: value.slice(5) };
  if (value === "skip:shop" || value === "skip:other") {
    return { skip: value.slice(5) as "shop" | "other" };
  }
  return null;
};

/**
 * Settings → Money → Revenue and business lines → From your books: whether
 * paid invoices and the books' other income count, and for each income
 * account invoices use, which line its invoices go to (or that it holds the
 * shop's own sales, so it is left out).
 */
export function BooksRevenueForm({
  slug,
  books,
  lines,
  accounts,
  currency,
}: {
  slug: string;
  books: BooksRevenue;
  lines: readonly BusinessLine[];
  accounts: readonly AccountOption[];
  currency: string;
}) {
  const [state, action] = useActionState<RevenueState, FormData>(
    saveBooksRevenue.bind(null, slug),
    {},
  );
  const [invoices, setInvoices] = useState(books.invoices);
  const [other, setOther] = useState(books.other_income);
  const [otherLine, setOtherLine] = useState(books.other_income_line ?? "");
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    Object.fromEntries(accounts.map((a) => [keyOf(a), choiceValue(a.choice)])),
  );
  // Choices for accounts not in the recent list are kept as they were.
  const listed = new Set(accounts.map(keyOf));
  const body: BooksRevenue = {
    invoices,
    other_income: other,
    other_income_line: otherLine || null,
    accounts: [
      ...books.accounts.filter((a) => !listed.has(keyOf(a))),
      ...accounts.flatMap((a) => {
        const choice = choiceOf(choices[keyOf(a)] ?? "");
        return choice && a.name ? [{ ref: a.ref, name: a.name, choice }] : [];
      }),
    ],
    // Kept on the server as they are; changed from the invoice list.
    customers: books.customers,
  };

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="body" value={JSON.stringify(body)} />
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={invoices}
          onChange={(e) => setInvoices(e.target.checked)}
          className="mt-1"
        />
        <span>
          Add paid invoices from my books
          <span className="text-muted-foreground block text-xs">
            Before tax, in the month of the invoice. Each one counts in the line its income account
            is pointed at below; an account you haven&apos;t chosen for counts nowhere yet.
          </span>
        </span>
      </label>
      {invoices &&
        (accounts.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No invoices have come across from your books yet.
          </p>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold">
              Where each account&apos;s invoices go
            </legend>
            {accounts.map((a) => {
              const id = `books-${keyOf(a)}`;
              return (
                <div key={keyOf(a)} className="grid gap-1 sm:grid-cols-[1fr_16rem] sm:items-center">
                  <Label htmlFor={id} className="font-normal">
                    {a.name ?? "No account on the line"}
                    <span className="text-muted-foreground block text-xs">
                      {a.invoices} {a.invoices === 1 ? "invoice" : "invoices"},{" "}
                      {formatMoney(a.cents / 100, currency)}
                    </span>
                  </Label>
                  <Select
                    id={id}
                    value={choices[keyOf(a)] ?? ""}
                    disabled={!a.name}
                    onChange={(e) => setChoices({ ...choices, [keyOf(a)]: e.target.value })}
                  >
                    <option value="">Not chosen yet (counts nowhere)</option>
                    {lines.map((line) => (
                      <option key={line.id} value={`line:${line.id}`}>
                        {line.name}
                      </option>
                    ))}
                    <option value="skip:shop">My shop&apos;s own sales (already counted)</option>
                    <option value="skip:other">Leave it out</option>
                  </Select>
                </div>
              );
            })}
          </fieldset>
        ))}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={other}
          onChange={(e) => setOther(e.target.checked)}
          className="mt-1"
        />
        <span>
          Add my books&apos; other income
          <span className="text-muted-foreground block text-xs">
            Interest and one-off income, from the &ldquo;other income&rdquo; part of your profit and
            loss. It never holds shop sales.
          </span>
        </span>
      </label>
      {other && lines.length > 0 && (
        <div className="flex flex-col gap-1 sm:w-80">
          <Label htmlFor="books-other-line">Count other income in</Label>
          <Select
            id="books-other-line"
            value={otherLine}
            onChange={(e) => setOtherLine(e.target.value)}
          >
            <option value="">None of my lines: show it as other revenue</option>
            {lines.map((line) => (
              <option key={line.id} value={line.id}>
                {line.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        Save
      </SubmitButton>
    </form>
  );
}

/**
 * The customers whose invoices go to one line by default, each with a way
 * to take it away. Set from Money → Invoices.
 */
export function InvoiceCustomersList({
  slug,
  customers,
  lines,
  canEdit,
  invoicesHref,
}: {
  slug: string;
  customers: BooksRevenue["customers"];
  lines: readonly BusinessLine[];
  canEdit: boolean;
  invoicesHref: string;
}) {
  const [state, action] = useActionState<RevenueState, FormData>(
    removeInvoiceCustomer.bind(null, slug),
    {},
  );
  const where = (choice: BookAccountChoice) =>
    "line" in choice
      ? (lines.find((l) => l.id === choice.line)?.name ?? "a line since removed")
      : choice.skip === "shop"
        ? "left out: your shop already counted them"
        : "left out";
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Customers whose invoices always go to one line</h3>
      {customers.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          None yet. On{" "}
          <Link href={invoicesHref} className="underline underline-offset-4">
            Invoices
          </Link>
          , choose &ldquo;Always put this customer&apos;s invoices in…&rdquo; beside one of theirs.
        </p>
      ) : (
        <ul className="divide-border border-border divide-y rounded-md border text-sm">
          {customers.map((c) => (
            <li
              key={c.ref ? `ref:${c.ref}` : `name:${c.name}`}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
            >
              <span>
                <span className="font-read">{c.name}</span> → {where(c.choice)}
              </span>
              {canEdit && (
                <form action={action}>
                  <input type="hidden" name="ref" value={c.ref ?? ""} />
                  <input type="hidden" name="name" value={c.name} />
                  <SubmitButton variant="ghost" size="sm">
                    Take this away
                  </SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <p className="text-muted-foreground text-xs">
        An invoice you sorted yourself keeps your choice; one with neither follows its income
        accounts.
      </p>
    </div>
  );
}
