"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SlipsButton } from "./print-ui";
import type { SlipSelection } from "./slips-data";

/**
 * The small actions under the order summary: the packing slip, putting the
 * order on hold, and the order's own page in the shop. Hold opens its form
 * underneath rather than sitting open on every order.
 */
export function OrderRailActions({
  slug,
  slip,
  shopLink,
  hold,
  scanHref,
}: {
  slug: string;
  /** The slip: where it opens, and the same choice for a computer that prints it straight to its Zebra. */
  slip: { href: string; selection: SlipSelection; label: string; printed: boolean } | null;
  shopLink: string | null;
  /** The hold form, and whether the order is on hold now. */
  hold: { form: React.ReactNode; held: boolean } | null;
  scanHref: string | null;
}) {
  const [open, setOpen] = useState(hold?.held ?? false);
  if (!slip && !shopLink && !hold && !scanHref) return null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {slip && (
          <SlipsButton
            slug={slug}
            href={slip.href}
            selection={slip.selection}
            title={slip.printed ? "Already printed once" : undefined}
          >
            {slip.label}
            {slip.printed && <span className="text-muted-foreground font-medium">(printed)</span>}
          </SlipsButton>
        )}
        {hold && (
          <Button
            type="button"
            variant={open ? "dark" : "outline"}
            size="sm"
            aria-expanded={open}
            aria-controls="order-hold"
            onClick={() => setOpen((before) => !before)}
          >
            {hold.held ? "On hold" : "Hold"}
          </Button>
        )}
        {shopLink && (
          <Button asChild variant="ghost" size="sm">
            <a href={shopLink} target="_blank" rel="noopener noreferrer">
              Shop ↗
            </a>
          </Button>
        )}
      </div>
      {hold && open && (
        <div id="order-hold" className="border-border bg-sunken rounded-md border p-3">
          {hold.form}
        </div>
      )}
      {scanHref && (
        <Link href={scanHref} className="text-muted-foreground w-fit text-xs hover:underline">
          Scan &amp; pack this order
        </Link>
      )}
    </div>
  );
}
