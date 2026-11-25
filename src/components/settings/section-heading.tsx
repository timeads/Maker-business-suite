import Link from "next/link";

/**
 * The top of one screen inside workspace Settings: a way back to the tool it
 * belongs to (so someone mid-task isn't lost), its name and one line on what
 * it's for. The page's own header ("Settings") comes from the layout.
 */
export function SectionHeading({
  title,
  description,
  back,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** The tool these settings belong to. */
  back?: { href: string; label: string };
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      {back && (
        <Link href={back.href} className="text-muted-foreground w-fit text-sm hover:underline">
          ← Back to {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg leading-tight font-bold tracking-[-0.01em]">{title}</h2>
          {description && (
            <p className="text-muted-foreground font-read mt-1 max-w-prose text-sm">
              {description}
            </p>
          )}
        </div>
        {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      </div>
    </div>
  );
}
