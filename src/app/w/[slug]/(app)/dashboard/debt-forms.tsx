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
import { PLAN_BALANCE_FROM, PLAN_BALANCE_WORDS } from "@/lib/dashboard/debt/plans";
import { syncNow, type ConnectionState } from "../connections/actions";
import {
  chooseBookLiability,
  chooseEmergencyAccounts,
  hideBookLiability,
  noteBalance,
  removeBalance,
  chooseStrategy,
  confirmDebtImport,
  followRecommended,
  previewDebtImport,
  removeDebt,
  removeWhatIf,
  coverDebt,
  saveDebt,
  saveDebtPlan,
  setPlanMonths,
  type DebtActionState,
  type DebtImportPreview,
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

/** A plan as its form holds it: amounts as typed text, and the debts it pays. */
export type DebtPlanFormValues = {
  id: string | null;
  name: string;
  status: string;
  rate: string;
  payment: string;
  due_day: string;
  priority: string;
  opening: string;
  note: string;
  balance_from: "covered" | "account" | "typed";
  plan_account_id: string;
  covers: string[];
};

/** A debt the plan could pay, with what the page knows about it. */
export type PlanCandidate = {
  id: string;
  name: string;
  /** "From your books: $1,200.00" or "No balance yet". */
  detail: string;
  /** Paid through another plan already: shown, not tickable. */
  takenBy: string | null;
};

/**
 * Make a plan that pays other debts, or change one: a business pays one
 * amount a month to a company that pays several of its debts. It counts as
 * ONE debt on a fixed payment; the debts it pays are kept, folded under it.
 */
export function DebtPlanForm({
  slug,
  values,
  currency,
  candidates,
  accounts,
}: {
  slug: string;
  values: DebtPlanFormValues;
  currency: string;
  candidates: PlanCandidate[];
  /** The books' liability accounts, for "its own account in your books". */
  accounts: { id: string; name: string; balance: string }[];
}) {
  const [state, action] = useActionState<DebtActionState, FormData>(
    saveDebtPlan.bind(null, slug),
    {},
  );
  const [from, setFrom] = useState(values.balance_from);
  const id = (name: string) => `plan-${values.id ?? values.plan_account_id ?? "new"}-${name}`;
  const field = (
    name: "name" | "rate" | "payment" | "due_day" | "priority" | "opening" | "note",
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
          defaultValue={values[name]}
          inputMode={more.inputMode}
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

  return (
    <form action={action} className="flex flex-col gap-4">
      {values.id && <input type="hidden" name="id" value={values.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        {field("name", "Name", { wide: true })}
        {field("payment", "The one payment a month", {
          suffix: currency,
          inputMode: "decimal",
          help: "What you pay the plan each month. The plan counts it as a fixed payment.",
        })}
        {field("rate", "Its yearly rate", {
          suffix: "%",
          inputMode: "decimal",
          help: "Often 0 for a plan like this. Take it from the plan's own paperwork.",
        })}
        {field("due_day", "Due on day", { inputMode: "numeric" })}
        {field("priority", "Its place in your own order", { inputMode: "numeric" })}
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={id("balance_from")}>Where its balance comes from</Label>
          <Select
            id={id("balance_from")}
            name="balance_from"
            value={from}
            onChange={(e) => setFrom(e.target.value as DebtPlanFormValues["balance_from"])}
            className="w-fit"
          >
            {PLAN_BALANCE_FROM.map((key) => (
              <option key={key} value={key}>
                {PLAN_BALANCE_WORDS[key]}
              </option>
            ))}
          </Select>
          <p className="text-muted-foreground text-xs">
            {from === "covered"
              ? "Follows your books on every sync: as the plan pays the cards down, its balance falls with them."
              : from === "account"
                ? "For books that carry the plan as a loan of its own: its balance is that account's."
                : "For when the plan's own statement says something different. Note each balance as it comes."}
          </p>
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={id("plan_account_id")}>
            {from === "account"
              ? "Its account in your books"
              : "Its own account in your books, if it has one"}
          </Label>
          <Select
            id={id("plan_account_id")}
            name="plan_account_id"
            defaultValue={values.plan_account_id}
            className="w-fit"
          >
            <option value="">{from === "account" ? "Pick one" : "None"}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.balance})
              </option>
            ))}
          </Select>
          <p className="text-muted-foreground text-xs">
            Payments are the money moved into this account. Without one, they&apos;re the payments
            into the debts it pays, added up. This account stops counting as a debt by itself.
          </p>
        </div>
        {from === "typed" && values.id === null && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id("balance")}>Owed today</Label>
            <div className="flex items-center gap-2">
              <Input id={id("balance")} name="balance" inputMode="decimal" className="w-36" />
              <span className="text-muted-foreground text-sm">{currency}</span>
            </div>
          </div>
        )}
        {field("opening", "What it started at", {
          suffix: currency,
          inputMode: "decimal",
          help: "For “paid off so far”. Leave blank to add up what its debts started at.",
        })}
        {values.id !== null && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id("status")}>Status</Label>
            <Select id={id("status")} name="status" defaultValue={values.status} className="w-fit">
              {DEBT_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {DEBT_STATUS_WORDS[st]}
                </option>
              ))}
            </Select>
          </div>
        )}
        {field("note", "A note", { wide: true })}
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">The debts it pays</legend>
        {candidates.length === 0 && (
          <p className="text-muted-foreground text-sm">No other debts yet.</p>
        )}
        {candidates.map((c) => (
          <label key={c.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2">
              <input
                type="checkbox"
                name="covers"
                value={c.id}
                className="size-4"
                defaultChecked={values.covers.includes(c.id)}
                disabled={c.takenBy !== null}
              />
              <span>
                {c.name}
                {c.takenBy && (
                  <span className="text-muted-foreground"> · paid through {c.takenBy}</span>
                )}
              </span>
            </span>
            <span className="text-muted-foreground tabular-nums">{c.detail}</span>
          </label>
        ))}
        <p className="text-muted-foreground text-xs">
          Each one ticked stops counting on its own: what you filled in on it is kept, and comes
          back just as it was if you untick it. A debt can be paid through one plan only.
        </p>
      </fieldset>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        {values.id ? "Save changes" : "Add this plan"}
      </SubmitButton>
    </form>
  );
}

/** "Count it on its own again": takes one debt out of its plan, exactly as it was. */
export function UncoverButton({
  slug,
  debtId,
  name,
}: {
  slug: string;
  debtId: string;
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
        aria-label={`Count ${name} on its own again`}
        onClick={() => start(async () => setSaid(await coverDebt(slug, debtId, null)))}
      >
        {pending ? "…" : "Count it on its own again"}
      </Button>
      {say(said)}
    </span>
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

/** "Follow the recommended order": back from a person's own choice. */
export function FollowRecommended({ slug }: { slug: string }) {
  const [said, setSaid] = useState<DebtActionState>({});
  const [pending, start] = useTransition();
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => start(async () => setSaid(await followRecommended(slug)))}
      >
        {pending ? "Saving…" : "Follow the recommended order"}
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

/**
 * The emergency fund's accounts, ticked from the bank accounts on the latest
 * balance sheet (their names and balances as the books have them).
 */
export function EmergencyAccountPicker({
  slug,
  banks,
  picked,
}: {
  slug: string;
  banks: { key: string; id: string | null; name: string; balance: string }[];
  /** Keys of the banks already chosen. */
  picked: string[];
}) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(picked));
  const [said, setSaid] = useState<DebtActionState>({});
  const [pending, start] = useTransition();
  const changed = ticked.size !== picked.length || [...ticked].some((key) => !picked.includes(key));
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Where the fund is kept</legend>
        {banks.map((bank) => (
          <label key={bank.key} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4"
                checked={ticked.has(bank.key)}
                onChange={(event) => {
                  const next = new Set(ticked);
                  if (event.target.checked) next.add(bank.key);
                  else next.delete(bank.key);
                  setTicked(next);
                }}
              />
              {bank.name}
            </span>
            <span className="text-muted-foreground tabular-nums">{bank.balance}</span>
          </label>
        ))}
      </fieldset>
      <span className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={changed ? "dark" : "outline"}
          className="w-fit"
          disabled={pending || ticked.size > 10}
          onClick={() =>
            start(async () =>
              setSaid(
                await chooseEmergencyAccounts(
                  slug,
                  banks
                    .filter((bank) => ticked.has(bank.key))
                    .map((bank) => ({ id: bank.id, name: bank.name })),
                ),
              ),
            )
          }
        >
          {pending ? "Saving…" : "Use these accounts"}
        </Button>
        {say(said)}
      </span>
    </div>
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

/**
 * "Bring your debt details across": a CSV read here in the browser, looked
 * at first, then brought across in one press (a second press changes
 * nothing). Only details nobody has set are filled.
 */
export function DebtImportForm({ slug }: { slug: string }) {
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<DebtImportPreview>({});
  const [key, setKey] = useState("");
  const [said, setSaid] = useState<DebtActionState>({});
  const [pending, start] = useTransition();

  const look = (body: string) =>
    start(async () => {
      setSaid({});
      setPreview(await previewDebtImport(slug, body));
      setKey(crypto.randomUUID());
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="debt-import-file">The spreadsheet, saved as CSV</Label>
        <Input
          id="debt-import-file"
          type="file"
          accept=".csv,text/csv,text/plain"
          className="sm:w-96"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > 200_000) {
              setPreview({
                error: "That file is too big. Save only the debts' rows and try again.",
              });
              return;
            }
            const body = await file.text();
            setFileName(file.name);
            setText(body);
            look(body);
          }}
        />
      </div>
      {pending && !preview.fills && <p className="text-muted-foreground text-sm">Reading…</p>}
      {preview.error && (
        <p role="alert" className="text-brick text-sm">
          {preview.error}
        </p>
      )}
      {preview.fills && (
        <div className="flex flex-col gap-3 text-sm" role="status">
          <p>
            {preview.fills.length === 0
              ? `Nothing in ${fileName || "that file"} needs filling in.`
              : `From ${fileName || "that file"}, this is what would be filled in. Anything you've already set stays as it is.`}
          </p>
          {preview.fills.length > 0 && (
            <ul className="flex flex-col gap-1">
              {preview.fills.map((fill) => (
                <li key={fill.line}>
                  <span className="font-medium">{fill.debt}</span>: {fill.words.join(", ")}
                  {fill.kept.length > 0 && (
                    <span className="text-muted-foreground">
                      {" "}
                      (keeping your {fill.kept.join(", ")})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {[...(preview.skipped ?? []), ...(preview.problems ?? [])].length > 0 && (
            <details>
              <summary className="text-muted-foreground cursor-pointer">
                Rows left out ({(preview.skipped?.length ?? 0) + (preview.problems?.length ?? 0)})
              </summary>
              <ul className="text-muted-foreground mt-1 flex flex-col gap-0.5">
                {[...(preview.problems ?? []), ...(preview.skipped ?? [])]
                  .sort((a, b) => a.line - b.line)
                  .map((row, i) => (
                    <li key={`${row.line}-${i}`}>
                      Line {row.line}: {row.text}
                    </li>
                  ))}
              </ul>
            </details>
          )}
          {preview.fills.length > 0 && text && (
            <span className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="dark"
                className="w-fit"
                disabled={pending}
                onClick={() => start(async () => setSaid(await confirmDebtImport(slug, text, key)))}
              >
                {pending ? "Bringing across…" : "Bring these across"}
              </Button>
              {say(said)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
