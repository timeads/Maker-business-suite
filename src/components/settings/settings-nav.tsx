"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Search } from "lucide-react";
import {
  activeSettings,
  filterSettings,
  settingsHref,
  type SettingsGroup,
  type SettingsSection,
} from "@/lib/settings/nav";
import { cn } from "@/lib/utils";

const ROW =
  "focus-visible:ring-ochre block rounded-sm px-2.5 py-1.5 text-sm transition-colors duration-150 outline-none focus-visible:ring-2";
const LIT = "bg-sunken text-foreground font-semibold";
const DIM = "text-text-2 hover:bg-hover hover:text-foreground";

/**
 * The list down the left of Settings: the workspace's own sections, then one
 * entry per tool with its screens beneath it. On a phone it folds into one
 * button that names where you are and opens the same list.
 */
export function SettingsNav({ slug, groups }: { slug: string; groups: SettingsGroup[] }) {
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const root = `/w/${slug}/settings`;
  const path = pathname.startsWith(root) ? pathname.slice(root.length) : "";
  const active = activeSettings(groups, path);
  const shown = filterSettings(groups, query);
  const searching = query.trim() !== "";

  const everything = groups.flatMap((group) => group.sections);
  const here = everything.find((section) => section.id === active.section);
  const hereChild = here?.children?.find((child) => child.id === active.child);
  const whereAmI = here ? [here.name, hereChild?.name].filter(Boolean).join(" › ") : "All settings";

  const row = (section: SettingsSection, lit: boolean, child = false) => (
    <Link
      href={settingsHref(slug, section)}
      aria-current={lit ? "page" : undefined}
      onClick={() => setOpen(false)}
      className={cn(ROW, lit ? LIT : DIM, child && "py-1 text-[13px]")}
    >
      {section.name}
    </Link>
  );

  return (
    <nav aria-label="Settings" className="md:sticky md:top-6 md:w-56 md:shrink-0 print:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="settings-sections"
        onClick={() => setOpen((was) => !was)}
        className="border-border bg-card flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm font-semibold md:hidden"
      >
        <span className="min-w-0 truncate">{whereAmI}</span>
        <ChevronDown
          aria-hidden
          className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      <div
        id="settings-sections"
        className={cn("flex-col gap-3 pt-3 md:flex md:pt-0", open ? "flex" : "hidden")}
      >
        <label className="relative block">
          <span className="sr-only">Find a setting</span>
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a setting"
            className="border-border bg-card focus-visible:ring-ochre h-9 w-full rounded-md border pr-2 pl-8 text-sm outline-none focus-visible:ring-2"
          />
        </label>
        {shown.length === 0 && (
          <p className="text-muted-foreground px-2.5 text-sm">
            Nothing by that name. Try another word.
          </p>
        )}
        {shown.map((group) => (
          <div key={group.name} className="flex flex-col gap-0.5">
            <p className="text-muted-foreground px-2.5 pb-1 text-[10.5px] font-semibold tracking-[0.16em] uppercase">
              {group.name}
            </p>
            <ul className="flex flex-col gap-0.5">
              {group.sections.map((section) => {
                const lit = section.id === active.section;
                const kids = section.children ?? [];
                // One screen under a tool needs no second row, unless a search found it.
                const unfolded = searching ? kids.length > 0 : lit && kids.length > 1;
                return (
                  <li key={section.id}>
                    {row(section, lit && !unfolded)}
                    {unfolded && (
                      <ul className="border-border mt-0.5 mb-1 ml-2.5 flex flex-col gap-0.5 border-l pl-2">
                        {kids.map((child) => (
                          <li key={child.id}>{row(child, child.id === active.child, true)}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
