"use client";

import { useEffect, useId, useRef, useState } from "react";

/** Text is formatted on the server, so server and browser always agree. */
export type TimePoint = {
  key: string;
  label: string;
  longLabel: string;
  value: number | null;
  /** The value written out, or a dash when there is none. */
  text: string;
};

type Props = {
  points: TimePoint[];
  /** Round axis steps covering the data, with their labels. */
  ticks: { value: number; label: string }[];
  /** column for amounts per period; line for a rate that moves over time. */
  variant: "column" | "line";
  /** What the values are, for the tooltip, the table and screen readers. */
  valueLabel: string;
  /** Shorter plots for small multiples sharing one scale. */
  plotHeight?: number;
  /** Small multiples share one table beneath them instead of one each. */
  table?: boolean;
};

const PLOT_HEIGHT = 200;
const AXIS_BAND = 26;
const TOP = 12;
const LEFT = 52;

/**
 * A single-series chart over time. Columns for totals, a line for rates.
 * Every value is also in the table view below it, and reachable by keyboard.
 */
export function TimeChart({
  points,
  ticks,
  variant,
  valueLabel,
  plotHeight = PLOT_HEIGHT,
  table = true,
}: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
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

  const right = variant === "line" ? 56 : 8;
  const plotWidth = Math.max(40, width - LEFT - right);
  const [min, max] = [ticks[0].value, ticks[ticks.length - 1].value];
  const y = (value: number) => TOP + plotHeight - ((value - min) / (max - min)) * plotHeight;
  const band = plotWidth / Math.max(1, points.length);
  const x = (index: number) => LEFT + band * index + band / 2;
  const barWidth = Math.max(2, Math.min(24, band - 2));
  const labelEvery = Math.max(1, Math.ceil((points.length * 46) / plotWidth));

  // Line segments break where a period has no value, rather than dipping to zero.
  const segments: { x: number; y: number }[][] = [];
  if (variant === "line") {
    let current: { x: number; y: number }[] = [];
    points.forEach((point, index) => {
      if (point.value === null) {
        if (current.length) segments.push(current);
        current = [];
      } else {
        current.push({ x: x(index), y: y(point.value) });
      }
    });
    if (current.length) segments.push(current);
  }
  const lastIndex = points.reduce((last, p, i) => (p.value !== null ? i : last), -1);
  const activePoint = active !== null ? points[active] : null;

  return (
    <div className="flex flex-col gap-3">
      <div ref={frame} className="relative" onPointerLeave={() => setActive(null)}>
        <svg
          width={width}
          height={TOP + plotHeight + AXIS_BAND}
          role="group"
          aria-labelledby={titleId}
          className="block max-w-full"
        >
          <title id={titleId}>{`${valueLabel} over time`}</title>

          {ticks.map(({ value: tick, label }) => (
            <g key={tick}>
              <line
                x1={LEFT}
                x2={LEFT + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--chart-grid)"
                strokeWidth={1}
              />
              <text
                x={LEFT - 8}
                y={y(tick)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {label}
              </text>
            </g>
          ))}

          {variant === "column" &&
            points.map((point, index) => {
              if (!point.value) return null;
              const top = y(Math.max(0, point.value));
              const bottom = y(Math.min(0, point.value));
              const height = Math.max(1, bottom - top);
              const radius = Math.min(4, height, barWidth / 2);
              const left = x(index) - barWidth / 2;
              // Rounded at the data end, square at the baseline.
              const path =
                point.value > 0
                  ? `M${left},${bottom} V${top + radius} Q${left},${top} ${left + radius},${top} H${left + barWidth - radius} Q${left + barWidth},${top} ${left + barWidth},${top + radius} V${bottom} Z`
                  : `M${left},${top} V${bottom - radius} Q${left},${bottom} ${left + radius},${bottom} H${left + barWidth - radius} Q${left + barWidth},${bottom} ${left + barWidth},${bottom - radius} V${top} Z`;
              return (
                <path
                  key={point.key}
                  d={path}
                  fill="var(--chart-1)"
                  opacity={active === null || active === index ? 1 : 0.45}
                />
              );
            })}

          {variant === "line" && (
            <>
              {segments.map((segment, index) => (
                <g key={index}>
                  {segment.length > 1 && (
                    <path
                      d={`M${segment[0].x},${y(0)} ${segment.map((p) => `L${p.x},${p.y}`).join(" ")} L${segment[segment.length - 1].x},${y(0)} Z`}
                      fill="var(--chart-1)"
                      opacity={0.1}
                    />
                  )}
                  <path
                    d={segment.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ")}
                    fill="none"
                    stroke="var(--chart-1)"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </g>
              ))}
              {activePoint && active !== null && (
                <line
                  x1={x(active)}
                  x2={x(active)}
                  y1={TOP}
                  y2={TOP + plotHeight}
                  stroke="var(--muted-foreground)"
                  strokeWidth={1}
                />
              )}
              {points.map((point, index) =>
                point.value !== null && (index === lastIndex || index === active) ? (
                  <circle
                    key={point.key}
                    cx={x(index)}
                    cy={y(point.value)}
                    r={4}
                    fill="var(--chart-1)"
                    stroke="var(--card)"
                    strokeWidth={2}
                  />
                ) : null,
              )}
              {lastIndex >= 0 && points[lastIndex].value !== null && (
                <text
                  x={x(lastIndex) + 10}
                  y={y(points[lastIndex].value as number)}
                  dy="0.32em"
                  className="fill-foreground text-xs font-medium"
                >
                  {points[lastIndex].text}
                </text>
              )}
            </>
          )}

          <line
            x1={LEFT}
            x2={LEFT + plotWidth}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--border)"
            strokeWidth={1}
          />

          {points.map((point, index) =>
            index % labelEvery === 0 ? (
              <text
                key={point.key}
                x={x(index)}
                y={TOP + plotHeight + 17}
                textAnchor="middle"
                className="fill-muted-foreground text-[11px]"
              >
                {point.label}
              </text>
            ) : null,
          )}

          {/* One hit area per period, as tall as the plot: aim at the date, not the mark. */}
          {points.map((point, index) => (
            <rect
              key={point.key}
              x={LEFT + band * index}
              y={TOP}
              width={band}
              height={plotHeight}
              fill="transparent"
              tabIndex={0}
              role="img"
              aria-label={`${point.longLabel}: ${point.value === null ? "no data" : point.text}`}
              className="outline-none focus-visible:stroke-[var(--ring)] focus-visible:stroke-2"
              onPointerMove={() => setActive(index)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
            />
          ))}
        </svg>

        {activePoint && active !== null && (
          <div
            role="status"
            className="border-border bg-card pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border px-2.5 py-1.5 text-xs whitespace-nowrap shadow-md"
            style={{ left: Math.min(Math.max(x(active), 70), width - 70) }}
          >
            <span className="block text-sm font-semibold">
              {activePoint.value === null ? "No data" : activePoint.text}
            </span>
            <span className="text-muted-foreground">
              {valueLabel} · {activePoint.longLabel}
            </span>
          </div>
        )}
      </div>

      {table && (
        <details className="text-sm">
          <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer text-xs">
            View as a table
          </summary>
          <table className="mt-2 w-full max-w-sm text-left text-sm">
            <thead>
              <tr className="text-muted-foreground border-border border-b text-xs">
                <th className="py-1 font-medium">Period</th>
                <th className="py-1 text-right font-medium">{valueLabel}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.key} className="border-border border-b last:border-0">
                  <td className="py-1">{point.longLabel}</td>
                  <td className="py-1 text-right tabular-nums">{point.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
