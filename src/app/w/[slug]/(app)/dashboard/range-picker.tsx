import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { PageRange } from "@/lib/dashboard/range";
import { periodChoices } from "@/lib/dashboard/range";
import { RANGE_LABELS, RANGE_PRESETS } from "@/lib/dashboard/schema";
import { cn } from "@/lib/utils";

/**
 * Money's date range: the presets as links, and any month, quarter or year
 * from three Januaries back picked from a list. Everything is in the address.
 */
export function RangePicker({
  here,
  shown,
  timezone,
  children,
}: {
  here: string;
  shown: PageRange;
  timezone: string;
  children?: React.ReactNode;
}) {
  const choices = periodChoices(new Date(), timezone);
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <nav aria-label="Date range" className="bg-muted flex w-fit flex-wrap gap-1 rounded-lg p-1">
          {RANGE_PRESETS.map((option) => (
            <Link
              key={option}
              href={`${here}?range=${option}`}
              aria-current={option === shown.preset ? "true" : undefined}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors",
                option === shown.preset
                  ? "bg-card font-medium shadow-xs"
                  : "text-muted-foreground hover:bg-card/60",
              )}
            >
              {RANGE_LABELS[option]}
            </Link>
          ))}
        </nav>
        <form action={here} className="flex items-center gap-2">
          <label htmlFor="money-period" className="sr-only">
            Pick a month, quarter or year
          </label>
          <select
            id="money-period"
            name="range"
            defaultValue={shown.period ? shown.value : ""}
            className="border-input bg-card h-9 rounded-sm border px-2 text-sm"
          >
            <option value="" disabled>
              A month, quarter or year…
            </option>
            {(["month", "quarter", "year"] as const).map((kind) => (
              <optgroup
                key={kind}
                label={kind === "month" ? "Months" : kind === "quarter" ? "Quarters" : "Years"}
              >
                {choices
                  .filter((c) => c.kind === kind)
                  .map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          <Button type="submit" variant="outline" size="sm">
            Show
          </Button>
        </form>
        {children}
      </div>
      {shown.period && (
        <p className="text-sm font-medium" role="status">
          Showing {shown.label}
        </p>
      )}
    </>
  );
}
