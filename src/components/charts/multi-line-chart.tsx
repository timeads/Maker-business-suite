"use client";

import { useEffect, useId, useRef, useState } from "react";
import { slotColour, type Marker } from "@/lib/charts/palette";
import { endLabels, tooltipRows, type PayoffChart } from "@/lib/dashboard/debt/payoff-chart";

const PLOT_HEIGHT = 240;
const AXIS_BAND = 26;
const TOP = 12;
const LEFT = 56;
const RIGHT = 12;

/** A small mark in a line's colour and shape, for the legend, tooltip and line ends. */
function MarkerShape({
  marker,
  x,
  y,
  colour,
  size = 4,
}: {
  marker: Marker;
  x: number;
  y: number;
  colour: string;
  size?: number;
}) {
  const ring = { fill: colour, stroke: "var(--card)", strokeWidth: 1.5 };
  switch (marker) {
    case "square":
      return <rect x={x - size} y={y - size} width={size * 2} height={size * 2} {...ring} />;
    case "triangle":
      return (
        <path
          d={`M${x},${y - size - 1} L${x + size + 1},${y + size} L${x - size - 1},${y + size} Z`}
          {...ring}
        />
      );
    case "diamond":
      return (
        <path
          d={`M${x},${y - size - 1} L${x + size + 1},${y} L${x},${y + size + 1} L${x - size - 1},${y} Z`}
          {...ring}
        />
      );
    default:
      return <circle cx={x} cy={y} r={size} {...ring} />;
  }
}

/** A line's key: a short stroke in its dash with its marker, as on the chart. */
function Swatch({ slot, dash, marker }: { slot: number | null; dash: string; marker: Marker }) {
  const colour = slotColour(slot);
  return (
    <svg width={26} height={12} aria-hidden className="shrink-0">
      <line
        x1={1}
        x2={25}
        y1={6}
        y2={6}
        stroke={colour}
        strokeWidth={2}
        strokeDasharray={dash || undefined}
      />
      <MarkerShape marker={marker} x={13} y={6} colour={colour} size={3} />
    </svg>
  );
}

/**
 * Several lines on one money axis over months, each in its own colour,
 * dash and marker (the payoff projection; the one chart that isn't in the
 * house's single series colour, see `lib/charts/palette.ts`). Hover, touch
 * or tab to a month for every line's figure there and the total; click a
 * legend entry to switch its line off or on. Every word was worked out on
 * the server; the table view holds every figure.
 */
export function MultiLineChart({
  chart,
  valueLabel,
  periodHeading = "Month",
}: {
  chart: PayoffChart;
  /** What the figures are, for screen readers and the table ("Owed at the end of the month"). */
  valueLabel: string;
  periodHeading?: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const titleId = useId();

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(280, entry.contentRect.width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { months, lines, ticks } = chart;
  const plotWidth = Math.max(40, width - LEFT - RIGHT);
  const max = ticks[ticks.length - 1]?.value || 1;
  const y = (cents: number) => TOP + PLOT_HEIGHT - (Math.max(0, cents) / max) * PLOT_HEIGHT;
  const step = plotWidth / Math.max(1, months.length - 1);
  const x = (index: number) => LEFT + (months.length === 1 ? plotWidth / 2 : step * index);
  const labelEvery = Math.max(1, Math.ceil((months.length * 52) / plotWidth));
  const shown = lines.filter((l) => !hidden.has(l.id));
  const labels = endLabels(shown, { x, y, right: LEFT + plotWidth });
  const rows = active === null ? [] : tooltipRows(chart, active, hidden);

  const toggle = (id: string) =>
    setHidden((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const pick = (clientX: number) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;
    const at = Math.round((clientX - box.left - LEFT) / Math.max(1, step));
    setActive(Math.min(months.length - 1, Math.max(0, at)));
  };

  if (months.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs" aria-label="Lines on the chart">
        {lines.map((l) => {
          const off = hidden.has(l.id);
          return (
            <li key={l.id}>
              <button
                type="button"
                aria-pressed={!off}
                title={l.members.length ? l.members.join(", ") : undefined}
                onClick={() => toggle(l.id)}
                className={`hover:bg-muted flex items-center gap-1.5 rounded px-1 py-0.5 text-left ${off ? "text-muted-foreground line-through opacity-60" : "text-foreground"}`}
              >
                <Swatch slot={l.slot} dash={l.dash} marker={l.marker} />
                <span>{l.name}</span>
                <span className="text-muted-foreground">· {l.words}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <div
        ref={frame}
        className="relative touch-pan-y"
        onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerDown={(e) => pick(e.clientX)}
      >
        <svg
          width={width}
          height={TOP + PLOT_HEIGHT + AXIS_BAND}
          role="group"
          aria-labelledby={titleId}
          className="block max-w-full"
        >
          <title id={titleId}>{`${valueLabel}, a line for each`}</title>

          {ticks.map(({ value, label }) => (
            <g key={value}>
              <line
                x1={LEFT}
                x2={LEFT + plotWidth}
                y1={y(value)}
                y2={y(value)}
                stroke="var(--chart-grid)"
                strokeWidth={1}
              />
              <text
                x={LEFT - 8}
                y={y(value)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {label}
              </text>
            </g>
          ))}
          <line
            x1={LEFT}
            x2={LEFT + plotWidth}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--border)"
            strokeWidth={1}
          />

          {active !== null && (
            <line
              x1={x(active)}
              x2={x(active)}
              y1={TOP}
              y2={TOP + PLOT_HEIGHT}
              stroke="var(--muted-foreground)"
              strokeWidth={1}
            />
          )}

          {shown.map((l) => {
            const colour = slotColour(l.slot);
            const last = l.values.reduce((at, v, i) => (v > 0 ? i : at), -1);
            const end =
              l.kind === "fund" ? l.values.length - 1 : Math.min(l.values.length - 1, last + 1);
            const points = l.values.slice(0, end + 1).map((v, i) => `${x(i)},${y(v)}`);
            return (
              <g key={l.id} aria-hidden>
                <polyline
                  points={points.join(" ")}
                  fill="none"
                  stroke={colour}
                  strokeWidth={2}
                  strokeDasharray={l.dash || undefined}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {end >= 0 && (
                  <MarkerShape marker={l.marker} x={x(end)} y={y(l.values[end])} colour={colour} />
                )}
                {active !== null && active <= end && (
                  <MarkerShape
                    marker={l.marker}
                    x={x(active)}
                    y={y(l.values[active])}
                    colour={colour}
                    size={4.5}
                  />
                )}
              </g>
            );
          })}

          {labels.map((label) => (
            <text
              key={label.id}
              x={label.x}
              y={label.y}
              dy="0.32em"
              aria-hidden
              className="fill-foreground text-[11px] font-medium"
              style={{ paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 3 }}
            >
              {label.name}
            </text>
          ))}

          {months.map((month, index) =>
            index % labelEvery === 0 ? (
              <text
                key={month.key}
                x={x(index)}
                y={TOP + PLOT_HEIGHT + 17}
                textAnchor="middle"
                className="fill-muted-foreground text-[11px]"
              >
                {month.label}
              </text>
            ) : null,
          )}

          {/* One focus stop per month, as tall as the plot: aim at the date, not the line. */}
          {months.map((month, index) => (
            <rect
              key={month.key}
              x={x(index) - step / 2}
              y={TOP}
              width={Math.max(4, step)}
              height={PLOT_HEIGHT}
              fill="transparent"
              tabIndex={0}
              role="img"
              aria-label={`${month.longLabel}: ${tooltipRows(chart, index, hidden)
                .map((r) => `${r.name} ${r.text}`)
                .join(", ")}`}
              className="outline-none focus-visible:stroke-[var(--ring)] focus-visible:stroke-2"
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
            />
          ))}
        </svg>

        {active !== null && rows.length > 0 && (
          <div
            role="status"
            className="border-border bg-card pointer-events-none absolute top-0 z-10 min-w-44 rounded-md border px-2.5 py-1.5 text-xs shadow-md"
            style={
              x(active) > width / 2
                ? { right: Math.max(4, width - x(active) + 12) }
                : { left: Math.max(4, x(active) + 12) }
            }
          >
            <span className="mb-1 block text-sm font-semibold">{months[active].longLabel}</span>
            <table className="w-full">
              <tbody>
                {rows.map((r) => {
                  const line = lines.find((l) => l.id === r.id);
                  return (
                    <tr key={r.id} className={r.kind === "total" ? "border-border border-t" : ""}>
                      <td className="py-0.5 pr-2">
                        <span className="flex items-center gap-1.5">
                          {line ? (
                            <Swatch slot={line.slot} dash={line.dash} marker={line.marker} />
                          ) : (
                            <span className="w-[26px]" />
                          )}
                          <span className={r.kind === "total" ? "font-semibold" : ""}>
                            {r.name}
                          </span>
                        </span>
                      </td>
                      <td
                        className={`py-0.5 text-right tabular-nums ${r.kind === "total" ? "font-semibold" : ""}`}
                      >
                        {r.text}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-muted-foreground text-xs">{chart.caption}</p>

      <details className="text-sm">
        <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer text-xs">
          View as a table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{valueLabel}</caption>
            <thead>
              <tr className="text-muted-foreground border-border border-b text-xs">
                <th scope="col" className="py-1 pr-3 font-medium">
                  {periodHeading}
                </th>
                {lines.map((l) => (
                  <th key={l.id} scope="col" className="px-2 py-1 text-right font-medium">
                    {l.name}
                  </th>
                ))}
                <th scope="col" className="py-1 pl-2 text-right font-medium">
                  All your debts
                </th>
              </tr>
            </thead>
            <tbody>
              {months.map((month, i) => (
                <tr key={month.key} className="border-border border-b last:border-0">
                  <th scope="row" className="py-1 pr-3 font-normal whitespace-nowrap">
                    {month.longLabel}
                  </th>
                  {lines.map((l) => (
                    <td key={l.id} className="px-2 py-1 text-right tabular-nums">
                      {l.texts[i]}
                    </td>
                  ))}
                  <td className="py-1 pl-2 text-right font-medium tabular-nums">
                    {chart.total.texts[i]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
