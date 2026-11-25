"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * A switch between views of ONE page, as an underlined row under the page
 * header (Active / Archived, say). A tool's own places are never tabs: they
 * live in its menu panel, defined in `lib/nav/model.ts`.
 */
export function SectionTabs({
  label,
  tabs,
}: {
  label: string;
  tabs: { href: string; name: string; exact?: boolean }[];
}) {
  const pathname = usePathname();
  return (
    <nav
      aria-label={label}
      className="border-border -mt-2 flex gap-5 overflow-x-auto border-b print:hidden"
    >
      {tabs.map((tab) => {
        const active = tab.exact
          ? pathname === tab.href
          : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 py-2 text-sm whitespace-nowrap transition-colors duration-150",
              active
                ? "border-ochre text-foreground font-semibold"
                : "text-muted-foreground hover:text-foreground border-transparent",
            )}
          >
            {tab.name}
          </Link>
        );
      })}
    </nav>
  );
}
