"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The views inside one tool, as an underlined row under the page header.
 * `settings` adds a small gear at the end of the row that goes straight to
 * the tool's section in workspace Settings; it stays put while the tabs scroll.
 */
export function SectionTabs({
  label,
  tabs,
  settings,
}: {
  label: string;
  tabs: { href: string; name: string; exact?: boolean }[];
  settings?: { href: string; label?: string };
}) {
  const pathname = usePathname();
  const row = (
    <nav
      aria-label={label}
      className={cn(
        "border-border flex gap-5 overflow-x-auto border-b",
        settings ? "min-w-0 flex-1" : "-mt-2 print:hidden",
      )}
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
  if (!settings) return row;
  return (
    <div className="-mt-2 flex items-stretch print:hidden">
      {row}
      <Link
        href={settings.href}
        title={settings.label ?? `${label} settings`}
        className="border-border text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-1.5 border-b pl-4 text-sm whitespace-nowrap transition-colors duration-150"
      >
        <Settings aria-hidden className="size-4" />
        <span className="max-sm:sr-only">Settings</span>
        <span className="sr-only sm:hidden">: {label}</span>
      </Link>
    </div>
  );
}
