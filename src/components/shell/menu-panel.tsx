"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Archive,
  AtSign,
  BarChart3,
  Check,
  CircleHelp,
  Clock,
  Folder,
  Inbox,
  Layers,
  Moon,
  OctagonAlert,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  Tag,
  Trash2,
  User,
  X,
  BookOpen,
} from "lucide-react";
import { filterMenu, hrefFor, type ItemIcon, type NavItem } from "@/lib/nav/model";
import { cn } from "@/lib/utils";
import { useShell } from "./nav-context";

/*
 * The panel's look, shared with a page that draws its own list in the
 * panel's place (Messages), so the two can't drift apart.
 */
export const PANEL_WIDTH = "w-[232px]";
export const PANEL_SURFACE = "border-border bg-card text-foreground border-r";
export const PANEL_HEAD = "flex h-[52px] shrink-0 items-center justify-between gap-2 pr-2 pl-4";
export const PANEL_TITLE = "min-w-0 truncate text-[15px] font-bold tracking-[-0.01em]";
export const PANEL_GROUP =
  "text-muted-foreground px-2.5 pt-4 pb-1 text-[10.5px] font-semibold tracking-[0.14em] uppercase";
export const PANEL_ROW =
  "focus-visible:ring-ochre flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-sm outline-none transition-colors duration-150 focus-visible:ring-2";
export const PANEL_ROW_ON = "bg-mint-soft text-foreground font-semibold";
export const PANEL_ROW_OFF = "text-text-2 hover:bg-hover hover:text-foreground";
export const PANEL_ICON_BUTTON =
  "text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ochre flex size-8 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2 [&_svg]:size-4";

const ITEM_ICONS: Record<ItemIcon, typeof Tag> = {
  chart: BarChart3,
  book: BookOpen,
  tag: Tag,
  user: User,
  help: CircleHelp,
  inbox: Inbox,
  clock: Clock,
  moon: Moon,
  at: AtSign,
  check: Check,
  layers: Layers,
  folder: Folder,
  archive: Archive,
  spam: OctagonAlert,
  trash: Trash2,
};

/** A tool's menu: its groups and rows, the same list in the panel and in the sheet. */
function MenuList({ onGo }: { onGo?: () => void }) {
  const shell = useShell();
  const [text, setText] = useState("");
  if (!shell?.menuOf) return null;
  const { slug, menuOf, menu, lit, here } = shell;
  const searching = text.trim() !== "";
  const groups = filterMenu(menu, text);

  const row = (item: NavItem, on: boolean, child = false) => {
    const Icon = item.icon ? ITEM_ICONS[item.icon] : null;
    return (
      <Link
        href={hrefFor(slug, item, here, on)}
        aria-current={on ? (item.filter ? "true" : "page") : undefined}
        onClick={onGo}
        className={cn(PANEL_ROW, on ? PANEL_ROW_ON : PANEL_ROW_OFF, child && "py-1 text-[13px]")}
      >
        {Icon && <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.count ? (
          <span className="text-muted-foreground shrink-0 text-xs font-semibold tabular-nums">
            {item.count > 999 ? "999+" : item.count}
          </span>
        ) : null}
      </Link>
    );
  };

  return (
    <>
      <nav
        aria-label={`${menuOf.name} menu`}
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3"
      >
        {menuOf.search && (
          <label className="relative mx-1 mb-1 block">
            <span className="sr-only">{menuOf.search}</span>
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
            />
            <input
              type="search"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={menuOf.search}
              className="border-border bg-card focus-visible:ring-ochre h-9 w-full rounded-md border pr-2 pl-8 text-sm outline-none focus-visible:ring-2"
            />
          </label>
        )}
        {groups.length === 0 && (
          <p className="text-muted-foreground px-2.5 pt-3 text-sm">
            Nothing by that name. Try another word.
          </p>
        )}
        {groups.map((group, index) => (
          <div key={group.id} className={cn(!group.name && index > 0 && "pt-3")}>
            {group.name && (
              <p className={cn(PANEL_GROUP, group.add && "flex items-center justify-between")}>
                {group.name}
                {group.add && !searching && (
                  <Link
                    href={`/w/${slug}/${group.add.to}`}
                    onClick={onGo}
                    aria-label={group.add.label}
                    title={group.add.label}
                    className="text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ochre -my-1 flex size-6 items-center justify-center rounded-sm outline-none focus-visible:ring-2"
                  >
                    <Plus aria-hidden className="size-3.5" />
                  </Link>
                )}
              </p>
            )}
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const kids = item.children ?? [];
                const mine = item.id === lit.item || item.id === lit.parent;
                // One screen under a row needs no second row, unless a search found it.
                const unfolded = searching ? kids.length > 0 : mine && kids.length > 1;
                const on = item.filter ? lit.filters.includes(item.id) : mine && !unfolded;
                return (
                  <li key={item.id}>
                    {row(item, on)}
                    {unfolded && (
                      <ul className="border-border mt-0.5 mb-1 ml-2.5 flex flex-col gap-0.5 border-l pl-2">
                        {kids.map((child) => (
                          <li key={child.id}>{row(child, child.id === lit.item, true)}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      {menuOf.settings && (
        <div className="border-border shrink-0 border-t p-1.5">
          <Link
            href={`/w/${slug}/${menuOf.settings.to}`}
            onClick={onGo}
            aria-label={`${menuOf.name} settings`}
            className={cn(PANEL_ROW, PANEL_ROW_OFF)}
          >
            <Settings aria-hidden className="text-muted-foreground size-4 shrink-0" />
            Settings
          </Link>
        </div>
      )}
    </>
  );
}

/**
 * The menu panel beside the hub rail: the menu of whichever tool you are in.
 * From 1024px it sits beside the page and can be folded away (remembered per
 * browser); under that it opens over the page from the header's menu button,
 * as a sheet that closes on Escape, on a press outside and when you go
 * somewhere.
 */
export function MenuPanel() {
  const shell = useShell();
  const sheet = useRef<HTMLDialogElement>(null);
  const open = Boolean(shell?.sheetOpen);
  useEffect(() => {
    const dialog = sheet.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  if (!shell?.menuOf || shell.panel !== "menu") return null;
  const { menuOf, collapsed, setCollapsed, closeSheet } = shell;

  return (
    <>
      <aside
        className={cn(
          PANEL_SURFACE,
          PANEL_WIDTH,
          "sticky top-0 h-dvh shrink-0 flex-col print:hidden",
          collapsed ? "hidden" : "hidden lg:flex",
        )}
      >
        <div className={PANEL_HEAD}>
          <p className={PANEL_TITLE}>{menuOf.name}</p>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-label={`Hide the ${menuOf.name} menu`}
            title="Hide this menu"
            className={PANEL_ICON_BUTTON}
          >
            <PanelLeftClose aria-hidden />
          </button>
        </div>
        <MenuList />
      </aside>

      <dialog
        ref={sheet}
        aria-label={`${menuOf.name} menu`}
        onClose={closeSheet}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeSheet();
        }}
        className="menu-sheet bg-card text-foreground fixed inset-y-0 right-auto left-0 m-0 h-dvh max-h-none w-[min(19rem,86vw)] max-w-none flex-col p-0 shadow-lg backdrop:bg-black/40 open:flex print:hidden"
      >
        <div className={PANEL_HEAD}>
          <p className={PANEL_TITLE}>{menuOf.name}</p>
          <button
            type="button"
            onClick={closeSheet}
            aria-label="Close the menu"
            className={PANEL_ICON_BUTTON}
          >
            <X aria-hidden />
          </button>
        </div>
        {open && <MenuList onGo={closeSheet} />}
      </dialog>
    </>
  );
}

/**
 * The menu button a page header carries. It shows only where the panel isn't
 * beside the page: on a phone or a narrow window it opens the menu as a
 * sheet, and on a wide one where the panel was folded away it brings it back.
 */
export function PanelButton({ className }: { className?: string }) {
  const shell = useShell();
  if (!shell?.menuOf || shell.panel === "none") return null;
  const { menuOf, panel, collapsed, sheetOpen, openMenu } = shell;
  const show =
    panel === "page"
      ? collapsed
        ? "hidden md:inline-flex"
        : "hidden"
      : collapsed
        ? "inline-flex"
        : "inline-flex lg:hidden";
  return (
    <button
      type="button"
      onClick={openMenu}
      aria-label={`${menuOf.name} menu`}
      aria-haspopup={panel === "menu" ? "dialog" : undefined}
      aria-expanded={panel === "menu" ? sheetOpen : undefined}
      title={`${menuOf.name} menu`}
      className={cn(
        "border-input bg-card text-text-2 hover:bg-hover focus-visible:ring-ochre size-9 shrink-0 items-center justify-center rounded-sm border outline-none focus-visible:ring-2 print:hidden [&_svg]:size-4",
        show,
        className,
      )}
    >
      <PanelLeft aria-hidden />
    </button>
  );
}
