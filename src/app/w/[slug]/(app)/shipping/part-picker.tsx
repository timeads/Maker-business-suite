"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { formatPart } from "@/lib/shipping/part";

type Line = { line_id: string; title: string; variant: string | null; left: number };

/**
 * How many of each item go now. Choosing opens the order again laid out for
 * just those items, so the box, the weight and the prices are all for what
 * is really going. Nothing is saved or bought here.
 */
export function PartPicker({
  href,
  lines,
  going,
}: {
  /** The order's own page, with whatever else its address carries. */
  href: string;
  lines: Line[];
  /** What is going now, when a part is already chosen. */
  going?: Record<string, number>;
}) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      lines.map((line) => [line.line_id, going ? (going[line.line_id] ?? 0) : line.left]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const total = lines.reduce((sum, line) => sum + line.left, 0);
  const chosen = lines.reduce((sum, line) => sum + (qty[line.line_id] ?? 0), 0);
  const join = href.includes("?") ? "&" : "?";

  function choose(event: React.FormEvent) {
    event.preventDefault();
    if (chosen <= 0) return setError("Say how many of at least one item are going now.");
    if (chosen >= total) {
      // Everything left is simply the whole order.
      router.push(href);
      return;
    }
    setError(null);
    router.push(
      `${href}${join}part=${encodeURIComponent(
        formatPart(lines.map((line) => ({ line_id: line.line_id, qty: qty[line.line_id] ?? 0 }))),
      )}`,
    );
  }

  return (
    <form onSubmit={choose} className="flex flex-col gap-3">
      <ul className="divide-border flex flex-col divide-y">
        {lines.map((line) => (
          <li key={line.line_id} className="flex items-center gap-3 py-2">
            <Input
              type="number"
              min={0}
              max={line.left}
              value={qty[line.line_id] ?? 0}
              onChange={(event) =>
                setQty((before) => ({
                  ...before,
                  [line.line_id]: Math.max(
                    0,
                    Math.min(line.left, Math.round(Number(event.target.value) || 0)),
                  ),
                }))
              }
              aria-label={`How many ${line.title} go now`}
              className="w-20"
            />
            <span className="text-sm">
              <span className="text-muted-foreground tabular-nums">of {line.left} · </span>
              <span className="font-read">
                {line.title}
                {line.variant ? ` (${line.variant})` : ""}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <FormMessage>{error}</FormMessage>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" size="sm">
          {chosen >= total ? "Send the whole order" : `Get rates for these ${chosen}`}
        </Button>
        <span className="text-muted-foreground text-xs">
          {chosen >= total
            ? "That's everything left, so it's the whole order."
            : `${total - chosen} will wait.`}
        </span>
      </div>
    </form>
  );
}
