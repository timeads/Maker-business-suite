"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Boxes } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import {
  approveTogether,
  notNowTogether,
  saveTogether,
  separateTogether,
  shipTogether,
  type TogetherState,
} from "./together-actions";

/** A group as the queue shows it: its orders oldest first, and who and where. */
export type TogetherGroup = {
  key: string;
  orderIds: string[];
  names: string[];
  customer: string;
  address: string;
  items: number;
  /** "saved 2 hours ago", for a group someone set aside to finish. */
  saved?: string;
};

type Asking = { ids: string[]; addresses: { name: string; address: string }[] };

/**
 * Opens orders as one. When their addresses don't read exactly the same, it
 * shows both and asks; a yes is remembered for that set of orders.
 */
export function useShipTogether(slug: string) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const sheet = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = sheet.current;
    if (!dialog) return;
    if (asking && !dialog.open) dialog.showModal();
    if (!asking && dialog.open) dialog.close();
  }, [asking]);

  const settle = (ids: string[], result: TogetherState) => {
    if (result.href) {
      setAsking(null);
      router.push(result.href);
    } else if (result.mismatch) {
      setAsking({ ids, addresses: result.mismatch });
    } else {
      setAsking(null);
      setError(result.error ?? "We couldn't open those together. Try again.");
    }
  };
  const open = (ids: string[]) =>
    start(async () => {
      setError(null);
      settle(ids, await shipTogether(slug, ids));
    });
  const approve = () => {
    if (!asking) return;
    const { ids } = asking;
    start(async () => settle(ids, await approveTogether(slug, ids)));
  };

  const dialog = (
    <dialog
      ref={sheet}
      onClose={() => setAsking(null)}
      aria-labelledby="together-ask"
      className="border-border bg-card text-foreground backdrop:bg-teal/40 m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl border p-5 shadow-lg"
    >
      {asking && (
        <div className="flex flex-col gap-3">
          <h2 id="together-ask" className="text-lg font-bold">
            Are these the same place?
          </h2>
          <p className="text-sm">
            These orders&apos; addresses don&apos;t read exactly the same. Have a look before they
            share a box.
          </p>
          <ul className="flex flex-col gap-2 text-sm">
            {asking.addresses.map((row) => (
              <li key={row.name} className="bg-sunken rounded-md px-3 py-2">
                <span className="font-semibold tabular-nums">{row.name}</span>
                <span className="font-read block">{row.address}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-sm">
            If you ship them together, the label goes to the first (oldest) order&apos;s address.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setAsking(null)}>
              No, keep them apart
            </Button>
            <Button type="button" variant="dark" disabled={pending} onClick={approve}>
              {pending ? "Opening…" : "Yes, ship them together"}
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );

  return { open, pending, error, dialog };
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Above the to-ship table: orders that could share a box, and groups someone
 * saved to finish. Suggestions only; nothing is combined until a label is bought.
 */
export function TogetherBanners({
  slug,
  suggestions,
  saved,
  canWrite,
}: {
  slug: string;
  suggestions: TogetherGroup[];
  saved: TogetherGroup[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const together = useShipTogether(slug);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  const quietly = (key: string, work: () => Promise<TogetherState>) =>
    start(async () => {
      setError(null);
      const result = await work();
      if (result.error) {
        setError(result.error);
        return;
      }
      setHidden((before) => new Set(before).add(key));
      router.refresh();
    });
  const card =
    "bg-card border-border flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3";
  const shownSaved = saved.filter((group) => !hidden.has(`saved:${group.key}`));
  const shownSuggestions = suggestions.filter((group) => !hidden.has(group.key));
  if (shownSaved.length === 0 && shownSuggestions.length === 0 && !together.error && !error) {
    return together.dialog;
  }

  return (
    <section aria-label="Orders that can ship together" className="flex flex-col gap-2">
      {shownSaved.map((group) => (
        <div key={`saved:${group.key}`} className={card}>
          <Boxes aria-hidden className="text-teal size-5 shrink-0" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-semibold">
              Saved to ship together: {count(group.names.length, "order")} for{" "}
              <span className="font-read">{group.customer || "one customer"}</span>
            </p>
            <p className="text-muted-foreground text-xs">
              <span className="tabular-nums">{group.names.join(" + ")}</span> ·{" "}
              {count(group.items, "item")} · <span className="font-read">{group.address}</span>
              {group.saved ? ` · ${group.saved}` : ""}
            </p>
          </div>
          <div className="flex gap-2">
            {canWrite && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                title="Stop shipping these together; each goes back to its own row"
                onClick={() =>
                  quietly(`saved:${group.key}`, () => separateTogether(slug, group.orderIds))
                }
              >
                Separate
              </Button>
            )}
            <Button
              variant="dark"
              size="sm"
              disabled={together.pending}
              onClick={() => together.open(group.orderIds)}
            >
              Open to buy label
            </Button>
          </div>
        </div>
      ))}
      {shownSuggestions.map((group) => (
        <div key={group.key} className={card}>
          <Boxes aria-hidden className="text-ochre-text size-5 shrink-0" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-semibold">
              Ship together? {count(group.names.length, "order")} for{" "}
              <span className="font-read">{group.customer || "one customer"}</span>
            </p>
            <p className="text-muted-foreground text-xs">
              <span className="tabular-nums">{group.names.join(" + ")}</span> ·{" "}
              {count(group.items, "item")} · <span className="font-read">{group.address}</span>
            </p>
          </div>
          <div className="flex gap-2">
            {canWrite && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => quietly(group.key, () => notNowTogether(slug, group.orderIds))}
              >
                Not now
              </Button>
            )}
            <Button
              variant="dark"
              size="sm"
              disabled={together.pending}
              onClick={() => together.open(group.orderIds)}
            >
              Ship together
            </Button>
          </div>
        </div>
      ))}
      <FormMessage>{together.error ?? error}</FormMessage>
      {together.dialog}
    </section>
  );
}

/** On the page of orders opened as one: what is happening, and the ways out. */
export function TogetherNote({
  slug,
  orderIds,
  names,
  saved,
  canWrite,
}: {
  slug: string;
  /** Oldest first; the first is the order the label is bought on. */
  orderIds: string[];
  names: string[];
  saved: boolean;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [result, setResult] = useState<TogetherState>({});

  return (
    <div
      role="note"
      className="bg-card border-border flex flex-col gap-3 rounded-xl border px-5 py-4 text-sm"
    >
      <div className="flex items-start gap-3">
        <Boxes aria-hidden className="text-teal mt-0.5 size-5 shrink-0" />
        <p>
          <span className="font-semibold">
            Shipping {names.length} orders together:{" "}
            <span className="tabular-nums">{names.join(" + ")}</span>.
          </span>{" "}
          One label covers everything below, going to the first order&apos;s address. Each order is
          marked as sent with the same tracking, so your customer hears about each one. Move items
          between boxes like any order.
        </p>
      </div>
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              start(async () => {
                const outcome = await saveTogether(slug, orderIds);
                setResult(outcome);
                if (!outcome.error) router.refresh();
              })
            }
          >
            {saved ? "Saved for later" : "Save for later"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            title="Stop shipping these together; each goes back to its own row"
            onClick={() =>
              start(async () => {
                const outcome = await separateTogether(slug, orderIds);
                if (outcome.error) setResult(outcome);
                else router.push(`/w/${slug}/shipping/orders/${orderIds[0]}`);
              })
            }
          >
            Separate
          </Button>
          <span className="text-muted-foreground text-xs">
            {saved
              ? "These wait together at the top of your to-ship list until the label is bought."
              : "Not buying the label yet? Save them and they wait together at the top of your to-ship list."}
          </span>
        </div>
      )}
      <FormMessage>{result.error}</FormMessage>
      <FormMessage kind="success">{result.message}</FormMessage>
    </div>
  );
}
