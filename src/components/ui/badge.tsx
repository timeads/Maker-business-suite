import { cn } from "@/lib/utils";

/**
 * Status in the house tones, always with words: open is teal, waiting is
 * ochre, good is mint, a problem is brick, finished is sunken stone.
 */
const TONES = {
  open: "bg-teal-soft text-teal-soft-ink",
  waiting: "bg-ochre-soft text-ochre-text",
  good: "bg-mint-soft text-mint-ink",
  bad: "bg-brick-soft text-brick",
  closed: "bg-sunken text-muted-foreground",
} as const;

export type BadgeTone = keyof typeof TONES;

export function Badge({
  tone = "closed",
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[21px] items-center rounded-full px-2 text-xs font-semibold whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
