import Link from "next/link";
import { Search } from "lucide-react";
import { helpCentrePath } from "@/lib/helpdesk/help-centre/config";
import type { HelpCentre } from "@/lib/helpdesk/help-centre-server";

export const centreTitle = (centre: HelpCentre) =>
  centre.config.title || `${centre.workspace.name} help`;

/**
 * The frame around every public help centre page: the business's name and
 * logo, a search box, and a way to write to them. Always light, and quiet
 * enough to sit beside anyone's brand.
 */
export function HelpShell({
  centre,
  query = "",
  children,
}: {
  centre: HelpCentre;
  query?: string;
  children: React.ReactNode;
}) {
  const home = helpCentrePath(centre.workspace.slug);
  return (
    <div className="bg-panel text-foreground flex min-h-dvh flex-col" data-theme="light">
      <header className="bg-card border-border border-b">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
          <Link
            href={home}
            className="focus-visible:ring-ochre flex min-w-0 items-center gap-3 rounded-sm outline-none focus-visible:ring-2"
          >
            {centre.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- the workspace's own logo, on our storage
              <img
                src={centre.logoUrl}
                alt=""
                className="h-9 w-auto max-w-[140px] object-contain"
              />
            )}
            <span className="truncate text-base font-bold tracking-[-0.01em]">
              {centreTitle(centre)}
            </span>
          </Link>
          <form action={home} method="get" role="search" className="relative w-full sm:w-64">
            <label htmlFor="help-search" className="sr-only">
              Search the help articles
            </label>
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            />
            <input
              id="help-search"
              type="search"
              name="q"
              defaultValue={query}
              maxLength={80}
              placeholder="Search for help"
              className="border-input bg-card focus-visible:border-ochre focus-visible:ring-ochre/25 h-10 w-full rounded-full border pr-4 pl-9 text-sm outline-none focus-visible:ring-2"
            />
          </form>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
        {children}
      </main>
      <footer className="border-border border-t">
        <div className="text-text-2 mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-6 text-sm sm:px-6">
          {centre.contactEmail && (
            <p className="font-read">
              {centre.config.contact_line}{" "}
              <a
                href={`mailto:${centre.contactEmail}`}
                className="text-ochre-text font-medium underline"
              >
                {centre.contactEmail}
              </a>
            </p>
          )}
          <p className="text-muted-foreground text-xs">Help centre by Maker Business Suite</p>
        </div>
      </footer>
    </div>
  );
}
