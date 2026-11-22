/** A headline number: when the data is one value, the number is the chart. */
export function StatTile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-3xl leading-tight font-semibold tracking-tight">{value}</span>
      {note && <span className="text-muted-foreground text-xs">{note}</span>}
    </div>
  );
}
