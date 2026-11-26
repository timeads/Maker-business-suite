import { TimeChart, type TimePoint } from "./time-chart";

export type LineSeries = { id: string; name: string; total: string; points: TimePoint[] };

/**
 * Several lines of the business over time, told apart without a second
 * colour: one small chart per line, stacked in the order the lines are set
 * up, each named above its own plot, all on one scale (so a taller bar
 * always means more) and all in the one series colour. One table beneath
 * holds every figure, a column per line.
 */
export function LineMultiples({
  series,
  ticks,
  valueLabel,
}: {
  series: LineSeries[];
  ticks: { value: number; label: string }[];
  valueLabel: string;
}) {
  const periods = series[0]?.points ?? [];
  return (
    <div className="flex flex-col gap-5">
      {series.map((line) => (
        <section key={line.id} aria-label={line.name} className="flex flex-col gap-1">
          <h3 className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-semibold">{line.name}</span>
            <span className="text-muted-foreground tabular-nums">{line.total}</span>
          </h3>
          <TimeChart
            points={line.points}
            ticks={ticks}
            variant="column"
            valueLabel={`${valueLabel}, ${line.name}`}
            plotHeight={90}
            table={false}
          />
        </section>
      ))}

      <details className="text-sm">
        <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer text-xs">
          View as a table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-muted-foreground border-border border-b text-xs">
                <th className="py-1 pr-3 font-medium">Period</th>
                {series.map((line) => (
                  <th key={line.id} className="py-1 pl-3 text-right font-medium">
                    {line.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {periods.map((period, index) => (
                <tr key={period.key} className="border-border border-b last:border-0">
                  <td className="py-1 pr-3 whitespace-nowrap">{period.longLabel}</td>
                  {series.map((line) => (
                    <td key={line.id} className="py-1 pl-3 text-right tabular-nums">
                      {line.points[index]?.text ?? "—"}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="font-medium">
                <td className="py-1 pr-3">Total</td>
                {series.map((line) => (
                  <td key={line.id} className="py-1 pl-3 text-right tabular-nums">
                    {line.total}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
