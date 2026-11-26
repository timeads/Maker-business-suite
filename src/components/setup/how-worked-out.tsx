import Link from "next/link";

/**
 * "How this is worked out": a small fold beside a figure or an automatic
 * decision, in plain words built from the workspace's own settings, with
 * the place that changes it where it can be changed.
 */
export function HowWorkedOut({
  lines,
  change,
  label = "How this is worked out",
}: {
  lines: readonly string[];
  change?: { href: string; label: string } | null;
  label?: string;
}) {
  if (lines.length === 0) return null;
  return (
    <details className="text-sm">
      <summary className="text-muted-foreground w-fit cursor-pointer text-xs hover:underline">
        {label}
      </summary>
      <div className="bg-muted mt-2 flex flex-col gap-1 rounded-md px-3 py-2">
        {lines.map((line, i) => (
          <p key={i} className="font-read text-text-2">
            {line}
          </p>
        ))}
        {change && (
          <Link
            href={change.href}
            className="text-ochre-text w-fit text-sm underline-offset-2 hover:underline"
          >
            {change.label}
          </Link>
        )}
      </div>
    </details>
  );
}
