"use client";

import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  DEBT_KINDS,
  DEBT_KIND_WORDS,
  DEBT_STATUSES,
  DEBT_STATUS_WORDS,
  PLAN_KIND_WORDS,
} from "@/lib/dashboard/debt/settings";
import { syncNow, type ConnectionState } from "../connections/actions";
import {
  chooseBookLiability,
  hideBookLiability,
  noteBalance,
  removeBalance,
  chooseStrategy,
  removeDebt,
  removeWhatIf,
  saveDebt,
  setPlanMonths,
  type DebtActionState,
} from "./debt-actions";

/** A debt as the form holds it: amounts as typed text in the workspace's currency. */
export type DebtFormValues = {
  id: string | null;
  name: string;
  kind: string;
  plan: string;
  status: string;
  rate: string;
  minimum: string;
  payment: string;
  revolving: string;
  due_day: string;
  priority: string;
  opening: string;
  books_account: string;
  note: string;
  /** Only when adding: what's owed today. */
  balance: string;
};

const say = (state: DebtActionState) =>
  state.error || state.message ? (
    <span
      role={state.error ? "alert" : "status"}
      className={state.error ? "text-brick text-xs" : "text-muted-foreground text-xs"}
    >
      {state.error ?? state.message}
    </span>
  ) : null;

/**
 * Add a debt or change one: what it is, how the plan pays it, and where it
 * sits in the books. A debt from the books (`fromBooks`) keeps the books'
 * name and account: only what the books can't say is asked.
 */
export function DebtForm({
  slug,
  values,
  currency,
  accounts,
  fromBooks = false,
}: {
  slug: string;
  values: DebtFormValues;
  currency: string;
  /** Accounts the books show money moving into, to link the debt to. */
  accounts: string[];
  fromBooks?: boolean;
}) {
  const [state, action] = useActionState<DebtActionState, FormData>(saveDebt.bind(null, slug), {});
  const id = (name: string) => `debt-${values.id ?? "new"}-${name}`;
  const field = (
    name: keyof DebtFormValues,
    label: string,
    more: {
      help?: string;
      suffix?: string;
      wide?: boolean;
      inputMode?: "decimal" | "numeric";
    } = {},
  ) => (
    <div className={`flex flex-col gap-1.5 ${more.wide ? "sm:col-span-2" : ""}`}>
      <Label htmlFor={id(name)}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id(name)}
          name={name}
          defaultValue={values[name] ?? ""}
          inputMode={more.inputMode}
          list={name === "books_account" ? id("accounts") : undefined}
          aria-describedby={more.help ? id(`${name}-help`) : undefined}
          className={more.wide ? undefined : "w-36"}
        />
        {more.suffix && <span className="text-muted-foreground text-sm">{more.suffix}</span>}
      </div>
      {more.help && (
        <p id={id(`${name}-help`)} className="text-muted-foreground text-xs">
          {more.help}
        </p>
      )}
    </div>
  );
  const choose = (name: "kind" | "plan" | "status", label: string, options: [string, string][]) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id(name)}>{label}</Label>
      <Select id={id(name)} name={name} defaultValue={values[name]} className="w-fit">
        {options.map(([value, words]) => (
          <option key={value} value={value}>
            {words}
          </option>
        ))}
      </Select>
    </div>
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      {values.id && <input type="hidden" name="id" value={values.id} />}
      {fromBooks && (
        <>
          <input type="hidden" name="name" value={values.name} />
          <input type="hidden" name="books_account" value={values.books_account} />
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {!fromBooks && field("name", "Name", { wide: true })}
        {choose(
          "kind",
          "What it is",
          DEBT_KINDS.map((k) => [k, DEBT_KIND_WORDS[k]]),
        )}
        {choose(
          "plan",
          "How it's paid",
          (["pool", "fixed", "revenue_share"] as const).map((k) => [k, PLAN_KIND_WORDS[k]]),
        )}
        {field("rate", "Yearly rate", {
          suffix: "%",
          inputMode: "decimal",
          help: fromBooks
            ? "QuickBooks doesn't keep this: take it from your statement."
            : undefined,
        })}
        {field("minimum", "Minimum a month", { suffix: currency, inputMode: "decimal" })}
        {field("payment", "Usual payment a month", {
          suffix: currency,
          inputMode: "decimal",
          help: "Leave blank if you pay the minimum.",
        })}
        {field("due_day", "Due on day", { inputMode: "numeric" })}
        {values.id === null &&
          field("balance", "Owed today", {
            suffix: currency,
            inputMode: "decimal",
            help: "Or link it to its account in your books below and the balance comes from there.",
          })}
        {field("opening", "What it started at", {
          suffix: currency,
          inputMode: "decimal",
          help: "For “paid off so far”. Optional.",
        })}
        {field("priority", "Its place in your own order", {
          inputMode: "numeric",
          help: "1 goes first. Used by the plan and by “your own order”.",
        })}
        {field("revolving", "A line of credit's least payment", {
          suffix: "% of what's owed",
          inputMode: "decimal",
          help: "Only for a line that asks a share of its balance each month. Optional.",
        })}
        {values.id !== null &&
          choose(
            "status",
            "Status",
            DEBT_STATUSES.map((s) => [s, DEBT_STATUS_WORDS[s]]),
          )}
        {!fromBooks &&
          field("books_account", "Its account in your books", {
            wide: true,
            help: "Leave blank for a debt that isn't in your books, like money a person lent you. Debts in your books come in by themselves when they sync.",
          })}
        <datalist id={id("accounts")}>
          {accounts.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        {field("note", "A note", { wide: true })}
      </div>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        {values.id ? "Save changes" : "Add this debt"}
      </SubmitButton>
    </form>
  );
}

/** A balance for a day, typed in by a person. */
export function BalanceForm({
  slug,
  debtId,
  name,
  today,
  currency,
}: {
  slug: string;
  debtId: string;
  name: string;
  today: string;
  currency: string;
}) {
  const [state, action] = useActionState<DebtActionState, FormData>(
    noteBalance.bind(null, slug),
    {},
  );
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="debt_id" value={debtId} />
      <div className="flex flex-col gap-1">
        <Label htmlFor={`bal-${debtId}`}>Owed</Label>
        <div className="flex items-center gap-1.5">
          <Input
            id={`bal-${debtId}`}
            name="balance"
            inputMode="decimal"
            className="h-8 w-32"
            aria-label={`What's owed on ${name}`}
          />
          <span className="text-muted-foreground text-xs">{currency}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`day-${debtId}`}>On</Label>
        <Input
          id={`day-${debtId}`}
          name="as_of"
          type="date"
          defaultValue={today}
          className="h-8 w-40"
        />
      </div>
      <SubmitButton size="sm" variant="outline" pendingText="Noting…">
        Note balance
      </SubmitButton>
      {say(state)}
    </form>
  );
}

/** Small buttons that act on one row: take a balance back, remove a debt. */
export function RowButton({
  slug,
  what,
  id,
  label,
  confirm,
}: {
  slug: string;
  what: "balance" | "debt";
  id: string;
  label: string;
  confirm?: string;
}) {
  const [said, setSaid] = useState<DebtActionState>({});
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          start(async () =>
            setSaid(
              what === "balance" ? await removeBalance(slug, id) : await removeDebt(slug, id),
            ),
          );
        }}
      >
        {pending ? "…" : label}
      </Button>
      {say(said)}
    </span>
  );
}

export type ScheduleRowValues = {
  month: string;
  label: string;
  pool: string;
  emergency: string;
  overridden: boolean;
};

/**
 * The schedule's amounts set by hand: any month's pool or emergency amount,
 * or one amount for every month from one onward. Blank goes back to worked out.
 */
export function ScheduleEditor({
  slug,
  rows,
  currency,
}: {
  slug: string;
  rows: ScheduleRowValues[];
  currency: string;
}) {
  const [from, setFrom] = useState(rows[0]?.month ?? "");
  const [pool, setPool] = useState("");
  const [emergency, setEmergency] = useState("");
  const [said, setSaid] = useState<DebtActionState>({});
  const [pending, start] = useTransition();
  const run = (list: { month: string; pool: string; emergency: string }[]) =>
    start(async () => setSaid(await setPlanMonths(slug, list)));

  return (
    <div className="flex flex-col gap-3">
      <div className="bg-muted flex flex-wrap items-end gap-3 rounded-lg p-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="sched-from">From</Label>
          <Select
            id="sched-from"
            className="h-8 w-36"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          >
            {rows.map((row) => (
              <option key={row.month} value={row.month}>
                {row.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="sched-pool">Pool for debts ({currency})</Label>
          <Input
            id="sched-pool"
            className="h-8 w-32"
            inputMode="decimal"
            placeholder="Worked out"
            value={pool}
            onChange={(e) => setPool(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="sched-emergency">Emergency fund ({currency})</Label>
          <Input
            id="sched-emergency"
            className="h-8 w-32"
            inputMode="decimal"
            placeholder="Worked out"
            value={emergency}
            onChange={(e) => setEmergency(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => run([{ month: from, pool, emergency }])}
        >
          Just that month
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            run(
              rows
                .filter((row) => row.month >= from)
                .map((row) => ({ month: row.month, pool, emergency })),
            )
          }
        >
          Use for every month from then on
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending || !rows.some((row) => row.overridden)}
          onClick={() =>
            run(
              rows
                .filter((row) => row.overridden)
                .map((row) => ({ month: row.month, pool: "", emergency: "" })),
            )
          }
        >
          Put every month back to worked out
        </Button>
      </div>
      {say(said)}
      <p className="text-muted-foreground text-xs">
        Leave both boxes blank and press the first button to put those months back to worked out.
      </p>
    </div>
  );
}

/** "Use this order" on a strategy's card. */
export function UseStrategy({
  slug,
  strategy,
  label,
}: {
  slug: string;
  strategy: string;
  label: string;
}) {
  const [said, setSaid] = useState<DebtActionState>({});
  const [pending, start] = useTransition();
  return (
    <span className="flex flex-col gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        aria-label={`Use the ${label} order`}
        onClick={() => start(async () => setSaid(await chooseStrategy(slug, strategy)))}
      >
        {pending ? "Saving…" : "Use this order"}
      </Button>
      {say(said)}
    </span>
  );
}

/** Takes a kept what-if off the list. */
export function RemoveWhatIf({ slug, id }: { slug: string; id: string }) {
  const [said, setSaid] = useState<DebtActionState>({});
  const [pending, start] = useTransition();
  return (
    <span className="flex items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        className="w-fit"
        disabled={pending}
        onClick={() => start(async () => setSaid(await removeWhatIf(slug, id)))}
      >
        {pending ? "…" : "Remove"}
      </Button>
      {say(said)}
    </span>
  );
}

/** "Count this as a debt" / "Not a debt" / "Let the setting decide", for one of the books' accounts. */
export function BookChoiceButton({
  slug,
  accountId,
  choice,
  label,
  variant = "outline",
}: {
  slug: string;
  accountId: string;
  choice: "debt" | "not_debt" | "rule";
  label: string;
  variant?: "outline" | "ghost";
}) {
  const [said, setSaid] = useState<DebtActionState>({});
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant={variant}
        disabled={pending}
        onClick={() =>
          start(async () => setSaid(await chooseBookLiability(slug, accountId, choice)))
        }
      >
        {pending ? "…" : label}
      </Button>
      {say(said)}
    </span>
  );
}

/** "Hide" or "Show again", for one of the books' other liabilities: only the list changes. */
export function HideLiabilityButton({
  slug,
  accountId,
  hidden,
  name,
}: {
  slug: string;
  accountId: string;
  hidden: boolean;
  name: string;
}) {
  const [said, setSaid] = useState<DebtActionState>({});
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        aria-label={hidden ? `Show ${name} again` : `Hide ${name}`}
        onClick={() =>
          start(async () => setSaid(await hideBookLiability(slug, accountId, !hidden)))
        }
      >
        {pending ? "…" : hidden ? "Show again" : "Hide"}
      </Button>
      {say(said)}
    </span>
  );
}

/** "Read the books now": queues a QuickBooks sync through the usual path (owners and admins). */
export function ReadBooksButton({ slug }: { slug: string }) {
  const [state, action] = useActionState<ConnectionState, FormData>(
    syncNow.bind(null, slug, "quickbooks"),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-1">
      <SubmitButton variant="outline" size="sm" pendingText="Starting…" className="w-fit">
        Read the books now
      </SubmitButton>
      {state.error && (
        <span role="alert" className="text-brick text-xs">
          {state.error}
        </span>
      )}
      {state.message && (
        <span role="status" className="text-muted-foreground text-xs">
          {state.message.replace(
            "This page updates when it finishes.",
            "Give it a few minutes, then refresh this page.",
          )}
        </span>
      )}
    </form>
  );
}
