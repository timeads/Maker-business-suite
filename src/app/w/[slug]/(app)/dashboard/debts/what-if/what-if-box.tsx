"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import type { WhatIfOutcome } from "@/lib/dashboard/debt/what-if";
import { askDebtWhatIf, keepWhatIf, type WhatIfReply } from "../../debt-actions";

const EXAMPLES = [
  "What if I paid 200 more a month?",
  "What if I paid 1,000 off the first card now?",
  "What if I used the snowball order instead?",
];

const monthWords = (month: string | null) =>
  month
    ? new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
        new Date(`${month}-01T00:00:00Z`),
      )
    : "not within the plan";

/**
 * Ask a what-if; see the engine's figures for the plan as it is and with
 * the change. Claude only reads the question; every figure is worked out
 * by the app. Nothing is kept unless you press "Keep this what-if".
 */
export function WhatIfBox({
  slug,
  currency,
  canKeep,
}: {
  slug: string;
  currency: string;
  canKeep: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [reply, setReply] = useState<WhatIfReply | null>(null);
  const [kept, setKept] = useState<{ error?: string; message?: string }>({});
  const [pending, start] = useTransition();
  const money = (cents: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  const freedom = (o: WhatIfOutcome) =>
    o.months === null
      ? "Not within 50 years"
      : `${o.months} months, by ${monthWords(o.payoffMonth)}`;

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setKept({});
          start(async () => setReply(await askDebtWhatIf(slug, question)));
        }}
      >
        <Label htmlFor="what-if">Your question</Label>
        <textarea
          id="what-if"
          rows={3}
          maxLength={500}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          className="border-input bg-card focus-visible:border-ochre focus-visible:ring-ochre/25 w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2"
          placeholder={EXAMPLES[0]}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={pending || question.trim().length < 3}>
            {pending ? "Working it out…" : "Work it out"}
          </Button>
          {EXAMPLES.map((example) => (
            <Button
              key={example}
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setQuestion(example)}
            >
              {example}
            </Button>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          Claude reads your question to see what to change; the app works out every figure. Each
          question counts toward your AI allowance.
        </p>
      </form>

      {reply && "error" in reply && (
        <p role="alert" className="text-brick text-sm">
          {reply.error}
        </p>
      )}

      {reply && !("error" in reply) && (
        <section
          aria-live="polite"
          className="border-border flex flex-col gap-3 rounded-lg border p-4"
        >
          <p className="font-read text-sm">“{reply.question}”</p>
          {!reply.understood || !reply.figures ? (
            <p className="text-sm">
              That one isn&apos;t a change the plan can try.{" "}
              {reply.summary && <span className="text-muted-foreground">{reply.summary}</span>}
            </p>
          ) : (
            <>
              <div className="text-sm">
                <span className="font-semibold">What was tried:</span>
                <ul className="mt-1 list-inside list-disc">
                  {reply.tried.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-muted-foreground text-xs">
                    <tr className="border-border border-b">
                      <th className="py-1 pr-3 font-medium" scope="col"></th>
                      <th className="px-2 py-1 font-medium" scope="col">
                        Your plan now
                      </th>
                      <th className="px-2 py-1 font-medium" scope="col">
                        With this change
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-border border-b">
                      <th scope="row" className="py-1 pr-3 font-normal">
                        Debt-free in
                      </th>
                      <td className="px-2 py-1">{freedom(reply.figures.now)}</td>
                      <td className="px-2 py-1">{freedom(reply.figures.whatIf)}</td>
                    </tr>
                    <tr className="border-border border-b">
                      <th scope="row" className="py-1 pr-3 font-normal">
                        Interest to come
                      </th>
                      <td className="px-2 py-1 tabular-nums">
                        {money(reply.figures.now.interest)}
                      </td>
                      <td className="px-2 py-1 tabular-nums">
                        {money(reply.figures.whatIf.interest)}
                      </td>
                    </tr>
                    <tr className="border-border border-b">
                      <th scope="row" className="py-1 pr-3 font-normal">
                        Emergency fund reached
                      </th>
                      <td className="px-2 py-1">{monthWords(reply.figures.now.emergencyMonth)}</td>
                      <td className="px-2 py-1">
                        {monthWords(reply.figures.whatIf.emergencyMonth)}
                      </td>
                    </tr>
                    {reply.figures.now.payoffs.map((p) => {
                      const after = reply.figures!.whatIf.payoffs.find((one) => one.id === p.id);
                      return (
                        <tr key={p.id} className="border-border border-b last:border-0">
                          <th scope="row" className="py-1 pr-3 font-normal">
                            {p.name} paid off
                          </th>
                          <td className="px-2 py-1">{monthWords(p.month)}</td>
                          <td className="px-2 py-1">
                            {after ? monthWords(after.month) : "Left out"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {canKeep && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      start(async () =>
                        setKept(await keepWhatIf(slug, reply.question, reply.changes)),
                      )
                    }
                  >
                    Keep this what-if
                  </Button>
                  {(kept.error || kept.message) && (
                    <span
                      role={kept.error ? "alert" : "status"}
                      className={
                        kept.error ? "text-brick text-xs" : "text-muted-foreground text-xs"
                      }
                    >
                      {kept.error ?? kept.message}
                    </span>
                  )}
                </div>
              )}
              <p className="text-muted-foreground text-xs">
                Nothing about your plan has changed. To make a change for real, change the debt or
                the plan settings.
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
