"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Printer, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { updatedAgo } from "@/lib/shipping/list";
import { usePrintSettings } from "@/lib/shipping/zebra/use-print-settings";

/**
 * How this computer prints, as a quiet chip that leads to where it's set.
 * Read from this browser once the page is live; until then, and wherever the
 * browser keeps nothing, it is ordinary browser printing.
 */
export function PrintingChip({ href }: { href: string }) {
  const [settings] = usePrintSettings();
  return (
    <Link
      href={href}
      title="How labels and slips print on this computer. Change it in Shipping settings."
      // Left out on a phone, where the header has no room and nobody prints.
      className="bg-sunken text-text-2 hover:bg-hover hidden h-[30px] items-center gap-1.5 rounded-full px-3 text-xs font-semibold whitespace-nowrap transition-colors duration-150 sm:inline-flex"
    >
      <Printer aria-hidden className="size-3.5" />
      {settings.labels === "zebra" ? "Zebra printing" : "Browser printing"}
    </Link>
  );
}

/**
 * "Updated 3 min ago" and a Refresh button. `readAt` is when the server read
 * the list; Refresh reads the page again, which gives a new one.
 */
export function ListFreshness({ readAt }: { readAt: number }) {
  const router = useRouter();
  const [now, setNow] = useState(readAt);
  const [pending, start] = useTransition();
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <>
      <span className="text-muted-foreground text-xs whitespace-nowrap" aria-live="off">
        {pending ? "Updating…" : updatedAgo(now - readAt)}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        title="Read the list again"
        onClick={() => start(() => router.refresh())}
      >
        <RefreshCw aria-hidden className={pending ? "animate-spin" : undefined} />
        Refresh
      </Button>
    </>
  );
}
