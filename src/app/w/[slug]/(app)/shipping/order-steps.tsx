"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

/**
 * "3 / 18", up and down to the neighbouring orders, and Close. K and J step
 * up and down and Esc closes, unless the person is typing in a field.
 */
export function OrderSteps({
  position,
  total,
  prev,
  next,
  close,
  listName,
}: {
  position: number | null;
  total: number;
  prev: string | null;
  next: string | null;
  close: string;
  listName: string;
}) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], dialog")) return;
      const to =
        event.key === "k" || event.key === "K"
          ? prev
          : event.key === "j" || event.key === "J"
            ? next
            : event.key === "Escape"
              ? close
              : null;
      if (!to) return;
      event.preventDefault();
      router.push(to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, prev, next, close]);

  const step =
    "border-input bg-card hover:bg-hover grid size-[30px] place-items-center rounded-sm border";
  const off = `${step} pointer-events-none opacity-40`;
  return (
    <nav aria-label="Orders in this list" className="flex items-center gap-2 text-sm">
      <span
        className="text-muted-foreground tabular-nums"
        aria-label={position ? `Order ${position} of ${total} in ${listName}` : undefined}
      >
        {position ? `${position} / ${total}` : `${total} in ${listName}`}
      </span>
      {prev ? (
        <Link href={prev} className={step} aria-label="Previous order" title="Previous order (K)">
          <ChevronUp className="size-4" aria-hidden />
        </Link>
      ) : (
        <span className={off} aria-hidden>
          <ChevronUp className="size-4" />
        </span>
      )}
      {next ? (
        <Link href={next} className={step} aria-label="Next order" title="Next order (J)">
          <ChevronDown className="size-4" aria-hidden />
        </Link>
      ) : (
        <span className={off} aria-hidden>
          <ChevronDown className="size-4" />
        </span>
      )}
      <Link
        href={close}
        className="border-input bg-card hover:bg-hover flex h-[30px] items-center gap-1.5 rounded-sm border px-2.5 text-xs font-semibold"
      >
        Close <kbd className="text-muted-foreground font-sans text-[10px]">Esc</kbd>
      </Link>
    </nav>
  );
}
