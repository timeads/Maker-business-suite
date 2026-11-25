import Link from "next/link";
import { PanelButton } from "@/components/shell/menu-panel";

/** The top of every workspace page: where you are, one line on what it's for, and what you can do. */
export function PageHeader({
  title,
  description,
  back,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  back?: { href: string; label: string };
  /** Actions, right-aligned. At most one of them filled. */
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2">
      {back && (
        <Link href={back.href} className="text-muted-foreground w-fit text-sm hover:underline">
          ← {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {/* The tool's menu, where the panel isn't beside the page. */}
          <PanelButton className="-mt-0.5" />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl leading-tight font-bold tracking-[-0.015em] text-balance">
              {title}
            </h1>
            {description && (
              <p className="text-muted-foreground font-read mt-1 text-sm lg:truncate">
                {description}
              </p>
            )}
          </div>
        </div>
        {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      </div>
    </header>
  );
}
