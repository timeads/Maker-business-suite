export type ValueKind = "money" | "percent";

export function formatMoney(
  value: number,
  currency: string,
  compact = false,
  /** Drop the cents, for lists where some amounts are large. */
  whole = false,
): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    ...(compact
      ? { notation: "compact", maximumFractionDigits: 1 }
      : whole || Math.abs(value) >= 1000
        ? { maximumFractionDigits: 0 }
        : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  }).format(value);
}

export function formatPercent(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function formatValue(value: number, kind: ValueKind, currency: string, compact = false) {
  return kind === "percent" ? formatPercent(value) : formatMoney(value, currency, compact);
}

/** Round axis steps: 0 / 500 / 1,000 rather than 0 / 437 / 874. */
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!(max > min)) return [min, min === 0 ? 1 : min + Math.abs(min)];
  const rough = (max - min) / target;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let tick = start; tick < max + step - 1e-9; tick += step) {
    ticks.push(Number(tick.toFixed(10)));
  }
  return ticks;
}

/** Everything a time chart draws as text, worked out once on the server. */
export function prepareTimeChart<P extends { value: number | null }>(
  points: P[],
  kind: ValueKind,
  currency: string,
): { points: (P & { text: string })[]; ticks: { value: number; label: string }[] } {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  const ticks = niceTicks(
    Math.min(0, ...values),
    Math.max(0, ...values, kind === "percent" ? 0.1 : 1),
  );
  return {
    points: points.map((p) => ({
      ...p,
      text: p.value === null ? "—" : formatValue(p.value, kind, currency),
    })),
    ticks: ticks.map((value) => ({ value, label: formatValue(value, kind, currency, true) })),
  };
}
