import type { CarrierMarkKey } from "@/lib/shipping/order-page";

/**
 * The carriers' own colours for their small marks: the same on a light or a
 * dark page, like the marks themselves. Anything else gets the plain tile.
 */
export const MARK_TONES: Record<CarrierMarkKey, React.CSSProperties | undefined> = {
  ups: { background: "#351c15", color: "#ffb500" },
  usps: { background: "#333366", color: "#ffffff" },
  fedex: { background: "#4d148c", color: "#ffffff" },
  dhl: { background: "#ffcc00", color: "#d40511" },
  ontrac: { background: "#0a3d7a", color: "#ffffff" },
  canpost: { background: "#da291c", color: "#ffffff" },
  other: undefined,
};

/** A carrier's small mark, as the list shows it beside a price. */
export function CarrierMark({ mark }: { mark: { key: CarrierMarkKey; label: string } }) {
  return (
    <span
      aria-hidden
      className={`grid h-[18px] min-w-[34px] shrink-0 place-items-center rounded px-1 text-[10px] leading-none font-extrabold tracking-wide ${mark.key === "other" ? "bg-sunken text-text-2" : ""}`}
      style={MARK_TONES[mark.key]}
    >
      {mark.label}
    </span>
  );
}
