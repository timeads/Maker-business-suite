"use client";

import { useActionState, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  FIGURE_WORDS,
  MATCH_KINDS,
  MATCH_WORDS,
  REVENUE_FIGURES,
  idFrom,
  type MatchKind,
  type RevenueSettings,
} from "@/lib/dashboard/lines";
import {
  saveBusinessLines,
  saveClosedMonths,
  saveRevenueFigure,
  type RevenueState,
} from "./actions";

/** Which figure counts as revenue, and whether a class counts in the month it runs. */
export function RevenueFigureForm({
  slug,
  settings,
}: {
  slug: string;
  settings: Pick<RevenueSettings, "figure" | "by_class_date">;
}) {
  const [state, action] = useActionState<RevenueState, FormData>(
    saveRevenueFigure.bind(null, slug),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">Count revenue as</legend>
        {REVENUE_FIGURES.map((figure) => (
          <label key={figure} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="figure"
              value={figure}
              defaultChecked={settings.figure === figure}
              className="mt-1"
            />
            <span>
              {FIGURE_WORDS[figure].choice}
              {figure === "net_sales" && <span className="text-muted-foreground"> (standard)</span>}
            </span>
          </label>
        ))}
      </fieldset>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="by_class_date"
          defaultChecked={settings.by_class_date}
          className="mt-1"
        />
        <span>
          Count a class in the month it runs, not the month it was bought
          <span className="text-muted-foreground block text-xs">
            For your business lines. The date comes from Bookings, or from a date written on the
            shop order by another booking app. What&apos;s paid for classes still to come shows on
            its own card.
          </span>
        </span>
      </label>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        Save
      </SubmitButton>
    </form>
  );
}

/** Where a month that has ended takes its revenue from: the shop's sales or the books' income. */
export function ClosedMonthsForm({
  slug,
  closed,
}: {
  slug: string;
  closed: RevenueSettings["closed_months"];
}) {
  const [state, action] = useActionState<RevenueState, FormData>(
    saveClosedMonths.bind(null, slug),
    {},
  );
  const choices = [
    {
      value: "shop",
      label: "Your shop's sales, every month",
      hint: "As Money has always counted it.",
    },
    {
      value: "books",
      label: "Your books, once a month has ended",
      hint: "Each month your books have closed takes its revenue from their income: the final number. This month stays on your shop's sales until then, and your shop's sales still decide how each month splits into your lines.",
    },
  ] as const;
  return (
    <form action={action} className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold">For a month that has ended, count</legend>
        {choices.map((choice) => (
          <label key={choice.value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="closed_months"
              value={choice.value}
              defaultChecked={closed === choice.value}
              className="mt-1"
            />
            <span>
              {choice.label}
              <span className="text-muted-foreground block text-xs">{choice.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        Save
      </SubmitButton>
    </form>
  );
}

type LineDraft = { id: string; name: string };
type RuleDraft = { id: string; match: MatchKind; words: string; line: string };

const split = (words: string) =>
  words
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);

/**
 * The business's own lines, which one takes whatever no rule matches, and
 * the rules, checked from the top. Handed to the server as one JSON field,
 * where it is checked against the same schema Money reads it with.
 */
export function BusinessLinesForm({
  slug,
  settings,
  suggestions,
}: {
  slug: string;
  settings: Pick<RevenueSettings, "lines" | "default_line" | "rules">;
  /** Tags and types seen on recent orders, to pick words from. */
  suggestions: { orderTags: string[]; productTypes: string[] };
}) {
  const [state, action] = useActionState<RevenueState, FormData>(
    saveBusinessLines.bind(null, slug),
    {},
  );
  const [lines, setLines] = useState<LineDraft[]>(settings.lines);
  const [fallback, setFallback] = useState<string | null>(settings.default_line);
  const [rules, setRules] = useState<RuleDraft[]>(
    settings.rules.map((rule) => ({ ...rule, words: rule.words.join(", ") })),
  );
  const [dirty, setDirty] = useState(false);
  const touch = () => setDirty(true);

  const lineIds = new Set(lines.map((line) => line.id));
  const defaultLine = fallback && lineIds.has(fallback) ? fallback : (lines[0]?.id ?? null);

  const addLine = () => {
    const id = idFrom(`line-${lines.length + 1}`, lineIds);
    setLines([...lines, { id, name: "" }]);
    touch();
  };
  const removeLine = (id: string) => {
    setLines(lines.filter((line) => line.id !== id));
    setRules(rules.filter((rule) => rule.line !== id));
    touch();
  };
  const addRule = () => {
    const taken = new Set(rules.map((rule) => rule.id));
    setRules([
      ...rules,
      {
        id: idFrom(`rule-${rules.length + 1}`, taken),
        match: "order_tag",
        words: "",
        line: lines.find((line) => line.id !== defaultLine)?.id ?? lines[0]?.id ?? "",
      },
    ]);
    touch();
  };
  const moveRule = (index: number, by: -1 | 1) => {
    const next = [...rules];
    const [rule] = next.splice(index, 1);
    next.splice(index + by, 0, rule);
    setRules(next);
    touch();
  };
  const changeRule = (index: number, change: Partial<RuleDraft>) => {
    setRules(rules.map((rule, i) => (i === index ? { ...rule, ...change } : rule)));
    touch();
  };

  const body = JSON.stringify({
    lines: lines.map((line) => ({ id: line.id, name: line.name.trim() })),
    default_line: lines.length ? defaultLine : null,
    rules: rules.map((rule) => ({
      id: rule.id,
      match: rule.match,
      words: MATCH_WORDS[rule.match].needsWords ? split(rule.words) : [],
      line: rule.line,
    })),
  });

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="body" value={body} />

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Lines</h3>
        {lines.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No lines yet. Add one for each part of your business you&apos;d like to see on its own,
            like your shop, your classes or commissions.
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {lines.map((line, index) => (
            <li key={line.id} className="flex flex-wrap items-center gap-2">
              <Label htmlFor={`line-${line.id}`} className="sr-only">
                Line {index + 1} name
              </Label>
              <Input
                id={`line-${line.id}`}
                value={line.name}
                maxLength={40}
                placeholder="A name, like Classes"
                className="sm:w-64"
                onChange={(event) => {
                  setLines(
                    lines.map((l) => (l.id === line.id ? { ...l, name: event.target.value } : l)),
                  );
                  touch();
                }}
              />
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="default_line_choice"
                  checked={defaultLine === line.id}
                  onChange={() => {
                    setFallback(line.id);
                    touch();
                  }}
                />
                Takes anything no rule matches
              </label>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => removeLine(line.id)}
                aria-label={`Remove ${line.name || `line ${index + 1}`}`}
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
        {lines.length < 12 && (
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={addLine}>
            <Plus aria-hidden /> Add a line
          </Button>
        )}
      </section>

      {lines.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">Rules</h3>
          <p className="text-muted-foreground text-sm">
            Each sale is checked against the rules from the top, and the first that matches decides
            its line. Capitals don&apos;t matter, and &ldquo;private-workshop&rdquo;,
            &ldquo;private_workshop&rdquo; and &ldquo;private workshop&rdquo; count as the same
            word.
          </p>
          <ol className="flex flex-col gap-3">
            {rules.map((rule, index) => (
              <li
                key={rule.id}
                className="border-border flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:flex-wrap sm:items-end"
              >
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`match-${rule.id}`}>When</Label>
                  <Select
                    id={`match-${rule.id}`}
                    value={rule.match}
                    className="sm:w-72"
                    onChange={(event) =>
                      changeRule(index, { match: event.target.value as MatchKind })
                    }
                  >
                    {MATCH_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {MATCH_WORDS[kind].label}
                      </option>
                    ))}
                  </Select>
                </div>
                {MATCH_WORDS[rule.match].needsWords && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`words-${rule.id}`}>Any of</Label>
                    <Input
                      id={`words-${rule.id}`}
                      value={rule.words}
                      placeholder={MATCH_WORDS[rule.match].hint}
                      list={
                        rule.match === "order_tag"
                          ? "recent-order-tags"
                          : rule.match === "product_type"
                            ? "recent-product-types"
                            : undefined
                      }
                      className="sm:w-64"
                      onChange={(event) => changeRule(index, { words: event.target.value })}
                    />
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`line-of-${rule.id}`}>It goes in</Label>
                  <Select
                    id={`line-of-${rule.id}`}
                    value={rule.line}
                    className="sm:w-52"
                    onChange={(event) => changeRule(index, { line: event.target.value })}
                  >
                    {lines.map((line, i) => (
                      <option key={line.id} value={line.id}>
                        {line.name.trim() || `Line ${i + 1}`}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="flex gap-1">
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
                    onClick={() => {
                      setRules(rules.filter((_, i) => i !== index));
                      touch();
                    }}
                    aria-label="Remove this rule"
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
          {rules.length < 60 && (
            <Button type="button" variant="outline" size="sm" className="w-fit" onClick={addRule}>
              <Plus aria-hidden /> Add a rule
            </Button>
          )}
          <datalist id="recent-order-tags">
            {suggestions.orderTags.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
          <datalist id="recent-product-types">
            {suggestions.productTypes.map((type) => (
              <option key={type} value={type} />
            ))}
          </datalist>
        </section>
      )}

      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton
        variant={dirty ? "default" : "outline"}
        pendingText="Saving…"
        className="sm:w-fit"
      >
        Save lines and rules
      </SubmitButton>
    </form>
  );
}
