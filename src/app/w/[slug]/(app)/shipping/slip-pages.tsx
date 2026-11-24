"use client";

import { SLIP_CSS, slipPageCss } from "@/lib/shipping/slip-css";
import { usePrintSettings } from "@/lib/shipping/zebra/use-print-settings";
import type { SlipData } from "@/lib/shipping/zebra/slip";
import { cn } from "@/lib/utils";
import { SlipSheet } from "./slip-sheet";

const SCREEN_CSS = `
@media screen {
  .slip-pages .slip { box-shadow: 0 1px 2px rgba(33, 56, 56, 0.12), 0 6px 18px -6px rgba(33, 56, 56, 0.25); border-radius: 4px; }
}
`;

/**
 * The slips as they print through the browser: each on a 4 × 6 label, or on
 * a letter page, as this computer is set. One to a page, with no margin of
 * the browser's own.
 */
export function SlipPages({
  slips,
  logoUrl,
}: {
  slips: { key: string; data: SlipData }[];
  logoUrl: string | null;
}) {
  const [settings] = usePrintSettings();
  const size = settings.slipPaper;
  return (
    <div className="slip-root slip-pages mx-auto flex w-fit max-w-full flex-col gap-6 overflow-x-auto bg-transparent print:mx-0 print:gap-0 print:overflow-visible">
      <style>{SLIP_CSS + SCREEN_CSS + slipPageCss(size)}</style>
      {slips.map((slip) => (
        <SlipSheet key={slip.key} slip={slip.data} logo={logoUrl} size={size} />
      ))}
    </div>
  );
}

/** 4 × 6 or letter, for slips printed through the browser on this computer. */
export function SlipPaperChoice() {
  const [settings, save] = usePrintSettings();
  return (
    <span
      role="group"
      aria-label="Paper"
      className="border-input inline-flex overflow-hidden rounded-sm border text-xs font-semibold print:hidden"
    >
      {(
        [
          ["4x6", "4 × 6"],
          ["letter", "Letter"],
        ] as const
      ).map(([value, text]) => (
        <button
          key={value}
          type="button"
          aria-pressed={settings.slipPaper === value}
          onClick={() => save({ slipPaper: value })}
          className={cn(
            "h-[30px] px-2.5",
            settings.slipPaper === value ? "bg-teal text-on-teal" : "bg-card hover:bg-hover",
          )}
        >
          {text}
        </button>
      ))}
    </span>
  );
}
