"use client";

import { useActionState, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  RULE_FIELDS,
  RULE_WORDS,
  accountChoiceFor,
  newRuleId,
  type AccountAction,
  type ExpenseSorting,
  type RuleField,
  type Sort,
} from "@/lib/dashboard/expenses";
import { accountKey, nextAccountChoices, type BookAccount } from "@/lib/dashboard/expense-accounts";
import { formatMoney } from "@/lib/dashboard/format";
import { toCents } from "@/lib/dashboard/lines";
import {
  COGS_SOURCES,
  COGS_WORDS,
  COST_KINDS,
  COST_WORDS,
  type CostKind,
  type ProfitSettings,
} from "@/lib/dashboard/profit";
import {
  saveAccountSorting,
  saveExpenseSorting,
  saveProfitSettings,
  type MoneySettingsState,
} from "./money-settings-actions";

type Line = { id: string; name: string };

/** How an action is held while it's being edited. */
type ActionDraft = { sort: Sort; line: string; split: Record<string, string> };

const toDraft = (
  action: { sort: Sort; line?: string; split?: Record<string, number> },
  lines: Line[],
): ActionDraft => ({
  sort: action.sort,
  line: action.sort === "line" ? (action.line ?? "") : (lines[0]?.id ?? ""),
  split: Object.fromEntries(
    Object.entries(action.sort === "split" ? (action.split ?? {}) : {}).map(([k, v]) => [
      k,
      String(v),
    ]),
  ),
});

/** Whole percents, only the lines given a share. */
const sharesOf = (draft: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(draft)
      .map(([line, value]) => [line, Math.round(Number(value) || 0)] as const)
      .filter(([, pct]) => pct > 0),
  );

const fromDraft = (draft: ActionDraft) => {
  switch (draft.sort) {
    case "line":
      return { sort: "line", line: draft.line };
    case "split":
      return { sort: "split", split: sharesOf(draft.split) };
    default:
      return { sort: draft.sort };
  }
};

/** Percent boxes, one per line, with the running total. */
function SharesInput({
  lines,
  value,
  onChange,
  idPrefix,
}: {
  lines: Line[];
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  idPrefix: string;
}) {
  const total = Object.values(sharesOf(value)).reduce((a, b) => a + b, 0);
  return (
    <div className="flex flex-wrap items-end gap-3">
      {lines.map((line) => (
        <div key={line.id} className="flex flex-col gap-1">
          <Label htmlFor={`${idPrefix}-${line.id}`} className="text-xs">
            {line.name}
          </Label>
          <span className="flex items-center gap-1 text-sm">
            <Input
              id={`${idPrefix}-${line.id}`}
              type="number"
              min={0}
              max={100}
              step={1}
              inputMode="numeric"
              value={value[line.id] ?? ""}
              className="w-20 tabular-nums"
              onChange={(event) => onChange({ ...value, [line.id]: event.target.value })}
            />
            %
          </span>
        </div>
      ))}
      <span className={total === 100 ? "pb-2 text-sm" : "text-brick pb-2 text-sm"} role="status">
        {total}% of 100%
      </span>
    </div>
  );
}

function ActionInput({
  lines,
  value,
  onChange,
  idPrefix,
}: {
  lines: Line[];
  value: ActionDraft;
  onChange: (next: ActionDraft) => void;
  idPrefix: string;
}) {
  const pick = value.sort === "line" ? `line:${value.line}` : value.sort;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-goes`}>It goes</Label>
        <Select
          id={`${idPrefix}-goes`}
          value={pick}
          className="sm:w-60"
          onChange={(event) => {
            const choice = event.target.value;
            if (choice.startsWith("line:"))
              onChange({ ...value, sort: "line", line: choice.slice(5) });
            else onChange({ ...value, sort: choice as Sort });
          }}
        >
          {lines.map((line) => (
            <option key={line.id} value={`line:${line.id}`}>
              On {line.name}
            </option>
          ))}
          {lines.length >= 2 && <option value="split">Split across lines</option>}
          <option value="shared">Shared across lines</option>
          <option value="set_aside">Not a business expense</option>
        </Select>
      </div>
      {value.sort === "split" && (
        <SharesInput
          lines={lines}
          value={value.split}
          idPrefix={`${idPrefix}-split`}
          onChange={(split) => onChange({ ...value, split })}
        />
      )}
    </div>
  );
}

/** An account's choice as the sorter holds it: "auto" is no choice (shared until one is made). */
type AccountDraft = { mode: "auto" | "each" | Sort; line: string; split: Record<string, string> };

const accountDraftOf = (action: AccountAction | null, lines: Line[]): AccountDraft => {
  if (!action) return { mode: "auto", line: lines[0]?.id ?? "", split: {} };
  if (action.sort === "each") return { mode: "each", line: lines[0]?.id ?? "", split: {} };
  const draft = toDraft(action, lines);
  return { mode: draft.sort, line: draft.line, split: draft.split };
};

const accountActionOf = (draft: AccountDraft): AccountAction | null => {
  if (draft.mode === "auto") return null;
  if (draft.mode === "each") return { sort: "each" };
  return fromDraft({ sort: draft.mode, line: draft.line, split: draft.split }) as AccountAction;
};

/**
 * One choice per account in the books: the main way expenses are sorted.
 * The whole list goes to the server as one JSON field, is checked against
 * the same schema the database reads, and is applied to every expense in
 * those accounts at once.
 */
export function AccountSortingForm({
  slug,
  settings,
  lines,
  accounts,
  currency,
}: {
  slug: string;
  settings: ExpenseSorting;
  lines: Line[];
  accounts: BookAccount[];
  currency: string;
}) {
  const [state, action] = useActionState<MoneySettingsState, FormData>(
    saveAccountSorting.bind(null, slug),
    {},
  );
  const named = accounts.filter((a) => a.name !== null);
  const [drafts, setDrafts] = useState<Record<string, AccountDraft>>(() =>
    Object.fromEntries(
      named.map((a) => [
        accountKey(a),
        accountDraftOf(accountChoiceFor(settings, a)?.action ?? null, lines),
      ]),
    ),
  );
  const [dirty, setDirty] = useState(false);
  const picked = new Map(
    named.map((a) => [accountKey(a), accountActionOf(drafts[accountKey(a)])] as const),
  );
  const body = JSON.stringify({ accounts: nextAccountChoices(settings.accounts, named, picked) });
  const change = (key: string, next: Partial<AccountDraft>) => {
    setDrafts({ ...drafts, [key]: { ...drafts[key], ...next } });
    setDirty(true);
  };
  const money = (cents: number) => formatMoney(cents / 100, currency);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="body" value={body} />
      <ul className="flex flex-col">
        {named.map((account) => {
          const key = accountKey(account);
          const draft = drafts[key];
          const pick = draft.mode === "line" ? `line:${draft.line}` : draft.mode;
          const id = `account-${key.replace(/[^A-Za-z0-9_-]/g, "-")}`;
          return (
            <li
              key={key}
              className="border-border flex flex-col gap-2 border-b py-3 last:border-0 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-0.5 sm:max-w-md">
                <Label htmlFor={id} className="font-medium">
                  {account.name}
                </Label>
                <span className="text-muted-foreground text-xs">
                  {account.recent === 0
                    ? "Nothing in the last 12 months"
                    : `${account.recent.toLocaleString("en-US")} ${account.recent === 1 ? "expense" : "expenses"}, ${money(account.recentCents)} in the last 12 months`}
                  {account.toSort > 0
                    ? ` · ${account.toSort.toLocaleString("en-US")} waiting in the inbox`
                    : ""}
                  {account.exceptions > 0
                    ? ` · ${account.exceptions.toLocaleString("en-US")} sorted another way by you or a rule`
                    : ""}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                <Select
                  id={id}
                  value={pick}
                  className="sm:w-72"
                  onChange={(event) => {
                    const choice = event.target.value;
                    if (choice.startsWith("line:"))
                      change(key, { mode: "line", line: choice.slice(5) });
                    else change(key, { mode: choice as AccountDraft["mode"] });
                  }}
                >
                  <option value="auto">Shared (automatic, until you choose)</option>
                  {lines.map((line) => (
                    <option key={line.id} value={`line:${line.id}`}>
                      On {line.name}
                    </option>
                  ))}
                  {lines.length >= 2 && <option value="split">Split across lines</option>}
                  <option value="shared">Shared across lines</option>
                  <option value="set_aside">Not a business expense</option>
                  <option value="each">Decide each one in the inbox</option>
                </Select>
                {draft.mode === "split" && (
                  <SharesInput
                    lines={lines}
                    value={draft.split}
                    idPrefix={`${id}-split`}
                    onChange={(split) => change(key, { split })}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton
        variant={dirty ? "default" : "outline"}
        pendingText="Sorting…"
        className="sm:w-fit"
      >
        Save and sort by account
      </SubmitButton>
    </form>
  );
}

type VendorDraft = { id: string; payee: string; action: ActionDraft; fill_in: boolean };
type RuleDraft = {
  id: string;
  field: RuleField;
  words: string;
  action: ActionDraft;
  fill_in: boolean;
  firm: boolean;
};

/**
 * Payee defaults and rules. Handed to the server as one JSON field, where it
 * is checked against the same schema the sync reads it with.
 */
export function ExpenseSortingForm({
  slug,
  settings,
  lines,
  payees,
  accounts,
}: {
  slug: string;
  settings: ExpenseSorting;
  lines: Line[];
  /** Seen in the books, to pick from. */
  payees: string[];
  accounts: string[];
}) {
  const [state, action] = useActionState<MoneySettingsState, FormData>(
    saveExpenseSorting.bind(null, slug),
    {},
  );
  const [vendors, setVendors] = useState<VendorDraft[]>(
    settings.vendors.map((v) => ({ ...v, action: toDraft(v.action, lines) })),
  );
  const [rules, setRules] = useState<RuleDraft[]>(
    settings.rules.map((r) => ({ ...r, action: toDraft(r.action, lines) })),
  );
  const [dirty, setDirty] = useState(false);
  const taken = () => new Set([...vendors.map((v) => v.id), ...rules.map((r) => r.id)]);
  const fresh = (): ActionDraft => ({ sort: "line", line: lines[0]?.id ?? "", split: {} });

  const changeVendor = (index: number, change: Partial<VendorDraft>) => {
    setVendors(vendors.map((v, i) => (i === index ? { ...v, ...change } : v)));
    setDirty(true);
  };
  const changeRule = (index: number, change: Partial<RuleDraft>) => {
    setRules(rules.map((r, i) => (i === index ? { ...r, ...change } : r)));
    setDirty(true);
  };
  const moveRule = (index: number, by: -1 | 1) => {
    const next = [...rules];
    const [rule] = next.splice(index, 1);
    next.splice(index + by, 0, rule);
    setRules(next);
    setDirty(true);
  };

  const body = JSON.stringify({
    vendors: vendors.map((v) => ({
      id: v.id,
      payee: v.payee.trim(),
      action: fromDraft(v.action),
      fill_in: v.fill_in,
    })),
    rules: rules.map((r) => ({
      id: r.id,
      field: r.field,
      words: r.words.trim(),
      action: fromDraft(r.action),
      fill_in: r.fill_in,
      firm: r.firm,
    })),
  });

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="body" value={body} />

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Payee defaults</h3>
        <p className="text-muted-foreground text-sm">
          Everything from one payee, sorted the same way. Capitals and spacing in the name
          don&apos;t matter.
        </p>
        {vendors.length === 0 && (
          <p className="text-muted-foreground text-sm">No payee defaults yet.</p>
        )}
        <ul className="flex flex-col gap-3">
          {vendors.map((vendor, index) => (
            <li
              key={vendor.id}
              className="border-border flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:flex-wrap sm:items-start"
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`payee-${vendor.id}`}>Payee</Label>
                <Input
                  id={`payee-${vendor.id}`}
                  value={vendor.payee}
                  maxLength={120}
                  list="seen-payees"
                  className="sm:w-64"
                  onChange={(event) => changeVendor(index, { payee: event.target.value })}
                />
              </div>
              <ActionInput
                lines={lines}
                value={vendor.action}
                idPrefix={`vendor-${vendor.id}`}
                onChange={(next) => changeVendor(index, { action: next })}
              />
              <label className="flex items-center gap-2 text-sm sm:mt-7">
                <input
                  type="checkbox"
                  checked={vendor.fill_in}
                  onChange={(event) => changeVendor(index, { fill_in: event.target.checked })}
                />
                Sort new ones by itself (otherwise only suggest)
              </label>
              <Button
                type="button"
                variant="danger"
                size="sm"
                className="sm:mt-6"
                aria-label={`Remove the default for ${vendor.payee || "this payee"}`}
                onClick={() => {
                  setVendors(vendors.filter((_, i) => i !== index));
                  setDirty(true);
                }}
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
        {vendors.length < 300 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => {
              setVendors([
                ...vendors,
                { id: newRuleId("payee", taken()), payee: "", action: fresh(), fill_in: true },
              ]);
              setDirty(true);
            }}
          >
            <Plus aria-hidden /> Add a payee default
          </Button>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Rules</h3>
        <p className="text-muted-foreground text-sm">
          Checked from the top; the first that matches decides. A rule ticked &ldquo;before payee
          defaults&rdquo; wins over them, for a payee with two kinds of charge.
        </p>
        {rules.length === 0 && <p className="text-muted-foreground text-sm">No rules yet.</p>}
        <ol className="flex flex-col gap-3">
          {rules.map((rule, index) => (
            <li
              key={rule.id}
              className="border-border flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:flex-wrap sm:items-start"
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`field-${rule.id}`}>When</Label>
                <Select
                  id={`field-${rule.id}`}
                  value={rule.field}
                  className="sm:w-72"
                  onChange={(event) =>
                    changeRule(index, { field: event.target.value as RuleField })
                  }
                >
                  {RULE_FIELDS.map((field) => (
                    <option key={field} value={field}>
                      {RULE_WORDS[field].label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`words-${rule.id}`}>These words</Label>
                <Input
                  id={`words-${rule.id}`}
                  value={rule.words}
                  maxLength={120}
                  placeholder={RULE_WORDS[rule.field].hint}
                  list={
                    rule.field === "account"
                      ? "seen-accounts"
                      : rule.field === "payee"
                        ? "seen-payees"
                        : undefined
                  }
                  className="sm:w-56"
                  onChange={(event) => changeRule(index, { words: event.target.value })}
                />
              </div>
              <ActionInput
                lines={lines}
                value={rule.action}
                idPrefix={`rule-${rule.id}`}
                onChange={(next) => changeRule(index, { action: next })}
              />
              <div className="flex flex-col gap-1 text-sm sm:mt-6">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={rule.fill_in}
                    onChange={(event) => changeRule(index, { fill_in: event.target.checked })}
                  />
                  Sort by itself (otherwise only suggest)
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={rule.firm}
                    onChange={(event) => changeRule(index, { firm: event.target.checked })}
                  />
                  Check before payee defaults
                </label>
              </div>
              <div className="flex gap-1 sm:mt-6">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={index === 0}
                  onClick={() => moveRule(index, -1)}
                  aria-label="Check this rule earlier"
                >
                  <ArrowUp aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={index === rules.length - 1}
                  onClick={() => moveRule(index, 1)}
                  aria-label="Check this rule later"
                >
                  <ArrowDown aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  aria-label="Remove this rule"
                  onClick={() => {
                    setRules(rules.filter((_, i) => i !== index));
                    setDirty(true);
                  }}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ol>
        {rules.length < 100 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => {
              setRules([
                ...rules,
                {
                  id: newRuleId("rule", taken()),
                  field: "payee",
                  words: "",
                  action: fresh(),
                  fill_in: true,
                  firm: false,
                },
              ]);
              setDirty(true);
            }}
          >
            <Plus aria-hidden /> Add a rule
          </Button>
        )}
      </section>

      <datalist id="seen-payees">
        {payees.map((payee) => (
          <option key={payee} value={payee} />
        ))}
      </datalist>
      <datalist id="seen-accounts">
        {accounts.map((account) => (
          <option key={account} value={account} />
        ))}
      </datalist>

      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton
        variant={dirty ? "default" : "outline"}
        pendingText="Saving…"
        className="sm:w-fit"
      >
        Save defaults and rules
      </SubmitButton>
    </form>
  );
}

type CostDraft = {
  id: string;
  name: string;
  how: CostKind;
  amount: string;
  rate: string;
  hours_per_week: string;
  hours_per_session: string;
  sessions_per_month: string;
  split: Record<string, string>;
};

const dollars = (cents: number) => (cents ? (cents / 100).toFixed(2) : "");
const cents = (text: string) => {
  const clean = text.replace(/[^0-9.]/g, "");
  return clean ? Math.max(0, toCents(clean)) : 0;
};
const number = (text: string) => {
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : 0;
};

/**
 * Cost of goods, how shared costs are shared out, and the monthly costs the
 * books don't hold. One JSON field, checked on the server.
 */
export function ProfitSettingsForm({
  slug,
  settings,
  lines,
  currency,
}: {
  slug: string;
  settings: ProfitSettings;
  lines: Line[];
  currency: string;
}) {
  const [state, action] = useActionState<MoneySettingsState, FormData>(
    saveProfitSettings.bind(null, slug),
    {},
  );
  const [cogs, setCogs] = useState(settings.cost_of_goods);
  const [shared, setShared] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(settings.shared_split).map(([k, v]) => [k, String(v)])),
  );
  const [costs, setCosts] = useState<CostDraft[]>(
    settings.monthly_costs.map((c) => ({
      id: c.id,
      name: c.name,
      how: c.how,
      amount: dollars(c.amount_cents),
      rate: dollars(c.rate_cents),
      hours_per_week: c.hours_per_week ? String(c.hours_per_week) : "",
      hours_per_session: c.hours_per_session ? String(c.hours_per_session) : "",
      sessions_per_month: c.sessions_per_month ? String(c.sessions_per_month) : "",
      split: Object.fromEntries(Object.entries(c.split).map(([k, v]) => [k, String(v)])),
    })),
  );
  const [dirty, setDirty] = useState(false);
  const change = (index: number, next: Partial<CostDraft>) => {
    setCosts(costs.map((c, i) => (i === index ? { ...c, ...next } : c)));
    setDirty(true);
  };

  const body = JSON.stringify({
    cost_of_goods: cogs,
    shared_split: sharesOf(shared),
    monthly_costs: costs.map((c) => ({
      id: c.id,
      name: c.name.trim(),
      how: c.how,
      amount_cents: c.how === "amount" ? cents(c.amount) : 0,
      rate_cents: c.how === "amount" ? 0 : cents(c.rate),
      hours_per_week: c.how === "weekly_hours" ? number(c.hours_per_week) : 0,
      hours_per_session: c.how === "sessions" ? number(c.hours_per_session) : 0,
      sessions_per_month: c.how === "sessions" ? number(c.sessions_per_month) : 0,
      split: sharesOf(c.split),
    })),
  });

  const field = (
    index: number,
    key: keyof CostDraft,
    label: string,
    unit: string,
    cost: CostDraft,
  ) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${key}-${cost.id}`}>{label}</Label>
      <span className="flex items-center gap-1 text-sm">
        <Input
          id={`${key}-${cost.id}`}
          inputMode="decimal"
          value={String(cost[key])}
          className="w-28 tabular-nums"
          onChange={(event) => change(index, { [key]: event.target.value })}
        />
        {unit}
      </span>
    </div>
  );

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="body" value={body} />

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">Cost of goods</legend>
        {COGS_SOURCES.map((source) => (
          <label key={source} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="cogs_choice"
              checked={cogs === source}
              className="mt-1"
              onChange={() => {
                setCogs(source);
                setDirty(true);
              }}
            />
            <span>
              {COGS_WORDS[source]}
              {source === "in_expenses" && (
                <span className="text-muted-foreground"> (standard)</span>
              )}
            </span>
          </label>
        ))}
        <p className="text-muted-foreground text-xs">
          Pick one, not both: if your supplier bills are sorted into lines too, counting item costs
          as well would take the same cost off twice.
        </p>
      </fieldset>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">How shared costs are shared out</h3>
        <p className="text-muted-foreground text-sm">
          Expenses you mark &ldquo;shared&rdquo; in the inbox are shared between your lines by these
          percents. Leave them all empty and shared costs show on their own.
        </p>
        <SharesInput
          lines={lines}
          value={shared}
          idPrefix="shared"
          onChange={(next) => {
            setShared(next);
            setDirty(true);
          }}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Monthly costs your books don&apos;t hold</h3>
        <p className="text-muted-foreground text-sm">
          Rent for a space one line uses, help paid by the hour or by the class, your own salary.
          Each month counts in full, and part of a month by the day. If the same cost is in your
          books too, set that expense aside in the inbox so it isn&apos;t counted twice.
        </p>
        {costs.length === 0 && (
          <p className="text-muted-foreground text-sm">No monthly costs yet.</p>
        )}
        <ul className="flex flex-col gap-3">
          {costs.map((cost, index) => (
            <li key={cost.id} className="border-border flex flex-col gap-3 rounded-md border p-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`name-${cost.id}`}>Name</Label>
                  <Input
                    id={`name-${cost.id}`}
                    value={cost.name}
                    maxLength={60}
                    placeholder="Like Studio rent"
                    className="sm:w-56"
                    onChange={(event) => change(index, { name: event.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`how-${cost.id}`}>Worked out as</Label>
                  <Select
                    id={`how-${cost.id}`}
                    value={cost.how}
                    className="sm:w-80"
                    onChange={(event) => change(index, { how: event.target.value as CostKind })}
                  >
                    {COST_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {COST_WORDS[kind]}
                      </option>
                    ))}
                  </Select>
                </div>
                {cost.how === "amount" && field(index, "amount", "A month", currency, cost)}
                {cost.how !== "amount" &&
                  field(index, "rate", "Hourly rate", `${currency} an hour`, cost)}
                {cost.how === "weekly_hours" &&
                  field(index, "hours_per_week", "Hours a week", "hours", cost)}
                {cost.how === "sessions" &&
                  field(index, "hours_per_session", "Hours a class", "hours", cost)}
                {cost.how === "sessions" &&
                  field(index, "sessions_per_month", "Classes a month", "classes", cost)}
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  aria-label={`Remove ${cost.name || "this cost"}`}
                  onClick={() => {
                    setCosts(costs.filter((_, i) => i !== index));
                    setDirty(true);
                  }}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-sm">Which lines it belongs to</span>
                <SharesInput
                  lines={lines}
                  value={cost.split}
                  idPrefix={`cost-${cost.id}`}
                  onChange={(split) => change(index, { split })}
                />
              </div>
            </li>
          ))}
        </ul>
        {costs.length < 30 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => {
              setCosts([
                ...costs,
                {
                  id: newRuleId("cost", new Set(costs.map((c) => c.id))),
                  name: "",
                  how: "amount",
                  amount: "",
                  rate: "",
                  hours_per_week: "",
                  hours_per_session: "",
                  sessions_per_month: "",
                  split: lines[0] ? { [lines[0].id]: "100" } : {},
                },
              ]);
              setDirty(true);
            }}
          >
            <Plus aria-hidden /> Add a monthly cost
          </Button>
        )}
      </section>

      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton
        variant={dirty ? "default" : "outline"}
        pendingText="Saving…"
        className="sm:w-fit"
      >
        Save
      </SubmitButton>
    </form>
  );
}
