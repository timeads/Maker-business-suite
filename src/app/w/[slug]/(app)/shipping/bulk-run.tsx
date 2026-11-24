"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/dashboard/format";
import { runSummary } from "@/lib/shipping/bulk";
import { printSettings, wantedLabelFormat } from "@/lib/shipping/zebra/settings";
import { buyRunOrder, startLabelRun, type RunStep } from "./bulk-actions";
import { sendLabelToZebra, type SentToZebra } from "./print-run";

type RunRow = {
  id: string;
  name: string;
  /** Null until its turn has come and gone. */
  step: RunStep | null;
  buying: boolean;
  /** How its label fared at the Zebra, on a computer set to print there. */
  printed: SentToZebra | "printing" | null;
};

type Run = {
  phase: "starting" | "buying" | "done";
  rows: RunRow[];
  leftOut: { id: string; name: string; why: string }[];
  error: string | null;
  /** The run stopped before every order had its turn. */
  stopped: boolean;
};

const LOST =
  "We lost touch with the server while this one was being bought, so we can't say what happened. Open the order before doing anything else with it: if a label was bought, it is there.";

/**
 * Buying labels for the ticked orders, one at a time, with what became of
 * each. The server does the checking and the buying; this only asks for the
 * next order when the last has answered, shows how it went and, on a computer
 * set to a Zebra, sends each label to the printer in the order they were
 * bought.
 */
export function useLabelRun(slug: string) {
  const router = useRouter();
  const [run, setRun] = useState<Run | null>(null);
  const going = useRef(false);
  const busy = run !== null && run.phase !== "done";

  // Leaving mid-run only stops the orders that haven't had their turn; say so first.
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const start = useCallback(
    async (ids: string[]) => {
      // One run at a time, and one press starts one run.
      if (going.current) return;
      going.current = true;
      const patch = (id: string, change: Partial<RunRow>) =>
        setRun(
          (before) =>
            before && {
              ...before,
              rows: before.rows.map((row) => (row.id === id ? { ...row, ...change } : row)),
            },
        );
      try {
        setRun({ phase: "starting", rows: [], leftOut: [], error: null, stopped: false });
        const begun = await startLabelRun(slug, ids).catch(() => null);
        if (!begun || begun.error || !begun.batchId || !begun.buy) {
          setRun({
            phase: "done",
            rows: [],
            leftOut: begun?.leftOut ?? [],
            error: begun?.error ?? "We couldn't start that run. Nothing was bought; try again.",
            stopped: false,
          });
          return;
        }
        setRun({
          phase: "buying",
          rows: begun.buy.map((order) => ({ ...order, step: null, buying: false, printed: null })),
          leftOut: begun.leftOut ?? [],
          error: null,
          stopped: false,
        });
        // This computer's own choice, read once: a Zebra gets its own format, and prints as we go.
        const settings = printSettings();
        const zebra = settings.labels === "zebra";
        let printing: Promise<unknown> = Promise.resolve();
        let stopped = false;
        for (const order of begun.buy) {
          patch(order.id, { buying: true });
          let step: RunStep;
          try {
            step = await buyRunOrder(slug, begun.batchId, order.id, wantedLabelFormat(settings));
          } catch {
            // No answer: this order may have been bought. Don't go on blind.
            patch(order.id, { buying: false, step: { status: "unsure", reason: LOST } });
            stopped = true;
            break;
          }
          patch(order.id, { buying: false, step });
          const shipmentId = step.status === "bought" ? step.shipmentId : undefined;
          if (zebra && shipmentId) {
            patch(order.id, { printed: "printing" });
            // One after another, in the order they were bought; buying doesn't wait for the printer.
            printing = printing.then(async () => {
              const printed = await sendLabelToZebra(slug, shipmentId, settings, true);
              patch(order.id, { printed });
            });
          }
        }
        await printing;
        setRun((before) => before && { ...before, phase: "done", stopped });
        router.refresh();
      } finally {
        going.current = false;
      }
    },
    [slug, router],
  );

  const close = () => setRun(null);
  return { busy, start, panel: run ? <RunPanel slug={slug} run={run} onClose={close} /> : null };
}

function RunPanel({ slug, run, onClose }: { slug: string; run: Run; onClose: () => void }) {
  const base = `/w/${slug}/shipping`;
  const done = run.rows.filter((row) => row.step).length;
  const steps = run.rows.flatMap((row) => (row.step ? [row.step] : []));
  const unsure = steps.filter((step) => step.status === "unsure").length;
  const title =
    run.phase === "starting"
      ? "Checking these orders…"
      : run.phase === "buying"
        ? `Buying labels… ${Math.min(done + 1, run.rows.length)} of ${run.rows.length}`
        : run.rows.length === 0
          ? "Nothing was bought"
          : runSummary(steps, formatMoney);
  return (
    <section
      aria-label="Buying labels"
      className="bg-card border-border flex flex-col gap-3 rounded-lg border px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 role="status" className="mr-auto text-sm font-bold tabular-nums">
          {title}
        </h2>
        {run.phase === "done" && (
          <>
            {run.rows.length > 0 && (
              <Link
                href={`${base}/batches`}
                className="text-ochre-text text-sm font-medium hover:underline"
              >
                See this run under Label batches
              </Link>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </>
        )}
      </div>
      {run.phase !== "done" && run.rows.length > 0 && (
        <div
          className="bg-sunken h-1.5 overflow-hidden rounded-full"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={run.rows.length}
          aria-valuenow={done}
        >
          <div
            className="bg-teal h-full transition-[width] duration-300"
            style={{ width: `${Math.round((done / run.rows.length) * 100)}%` }}
          />
        </div>
      )}
      {run.phase === "buying" && (
        <p className="text-muted-foreground text-xs">
          Keep this page open until it&apos;s finished. Each order is bought on its own, so one that
          can&apos;t be bought doesn&apos;t stop the rest.
        </p>
      )}
      {run.error && <p className="text-brick text-sm">{run.error}</p>}
      {run.phase === "done" && (unsure > 0 || run.stopped) && (
        <p className="bg-brick-soft text-brick rounded-md px-3 py-2 text-sm">
          {unsure === 1 ? "One order needs" : `${unsure} orders need`} a look before anything else
          is done with {unsure === 1 ? "it" : "them"}: open {unsure === 1 ? "it" : "each"} and see
          “Labels to finish”. Please don&apos;t buy {unsure === 1 ? "it" : "them"} again until then.
          {run.stopped && " The run stopped there; the orders after it were not bought."}
        </p>
      )}
      {run.rows.length > 0 && (
        <ul className="divide-border divide-y text-sm">
          {run.rows.map((row) => {
            const step = row.step;
            return (
              <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <Link
                  href={`${base}/orders/${row.id}`}
                  className="w-20 shrink-0 font-bold tabular-nums hover:underline"
                >
                  {row.name}
                </Link>
                {!step ? (
                  <span className="text-muted-foreground">
                    {row.buying
                      ? "Buying…"
                      : run.phase === "done"
                        ? "Not bought: the run stopped first"
                        : "Waiting its turn"}
                  </span>
                ) : step.status === "bought" ? (
                  <>
                    <span className="text-mint-ink flex items-center gap-1 font-semibold">
                      <Check aria-hidden className="size-3.5" />
                      Bought
                    </span>
                    <span className="min-w-0 flex-1">
                      {step.service} ·{" "}
                      <b className="tabular-nums">
                        {formatMoney(Number(step.price), step.currency)}
                      </b>
                    </span>
                    <span className="flex flex-wrap items-center gap-x-3 text-xs">
                      {row.printed === "printing" && (
                        <span className="text-muted-foreground">Printing…</span>
                      )}
                      {row.printed && row.printed !== "printing" && (
                        <span className={row.printed.ok ? "text-muted-foreground" : "text-brick"}>
                          {row.printed.text}
                        </span>
                      )}
                      {(step.labels ?? []).map((label) => (
                        <a
                          key={label.href}
                          href={label.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-ochre-text font-medium hover:underline"
                        >
                          {label.text}
                        </a>
                      ))}
                    </span>
                  </>
                ) : step.status === "unsure" ? (
                  <>
                    <span className="text-brick flex items-center gap-1 font-semibold">
                      <TriangleAlert aria-hidden className="size-3.5" />
                      Needs a look
                    </span>
                    <span className="min-w-0 flex-1 basis-64">{step.reason}</span>
                  </>
                ) : (
                  <>
                    <span className="text-text-2 font-semibold">Skipped</span>
                    <span className="text-muted-foreground min-w-0 flex-1 basis-64">
                      {step.reason}
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {run.leftOut.length > 0 && (
        <details className="text-sm" open={run.rows.length === 0}>
          <summary className="text-muted-foreground cursor-pointer">
            {run.leftOut.length === 1 ? "1 order was" : `${run.leftOut.length} orders were`} left
            out
          </summary>
          <ul className="mt-1 flex flex-col gap-1">
            {run.leftOut.map((order) => (
              <li key={order.id}>
                <Link
                  href={`${base}/orders/${order.id}`}
                  className="font-semibold tabular-nums hover:underline"
                >
                  {order.name}
                </Link>{" "}
                <span className="text-muted-foreground">{order.why}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
