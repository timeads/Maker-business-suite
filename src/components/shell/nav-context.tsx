"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  PANEL_COOKIE,
  activeIn,
  toolAt,
  withExtras,
  type ActiveRows,
  type Here,
  type NavGroup,
  type NavTool,
  type PanelExtras as Extras,
} from "@/lib/nav/model";

/** From this width up the panel sits beside the page; under it, it opens over the page. */
const DOCKED = "(min-width: 1024px)";

type Shell = {
  slug: string;
  tools: NavTool[];
  /** The tool the address belongs to (its icon is the lit one). */
  tool: NavTool | null;
  /** The tool whose menu the panel holds here, if there is a panel. */
  menuOf: NavTool | null;
  panel: NavTool["panel"];
  /** That menu, with whatever the page has added to it. */
  menu: NavGroup[];
  lit: ActiveRows;
  here: Here;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  sheetOpen: boolean;
  /** The header's menu button: unfolds the panel where it fits, else opens it over the page. */
  openMenu: () => void;
  closeSheet: () => void;
  setExtras: (tool: string, extras: Extras) => void;
};

const ShellContext = createContext<Shell | null>(null);

/** The shell's state, or null on a page outside a workspace. */
export const useShell = () => useContext(ShellContext);

export function NavProvider({
  slug,
  tools,
  startCollapsed,
  children,
}: {
  slug: string;
  tools: NavTool[];
  startCollapsed: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const [collapsed, setCollapsedState] = useState(startCollapsed);
  // The sheet remembers the address it was opened on, so going anywhere closes it.
  const [sheetAt, setSheetAt] = useState<string | null>(null);
  const [extras, setAllExtras] = useState<Record<string, Extras>>({});

  const root = `/w/${slug}`;
  const path = pathname.startsWith(root) ? pathname.slice(root.length).replace(/^\/+/, "") : "";
  const searchText = search.toString();
  const address = `${pathname}?${searchText}`;

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    try {
      document.cookie = `${PANEL_COOKIE}=${next ? "closed" : "open"}; path=/; max-age=31536000; samesite=lax`;
    } catch {
      // A browser that refuses cookies simply forgets.
    }
  }, []);
  const setExtras = useCallback((tool: string, next: Extras) => {
    setAllExtras((was) => ({ ...was, [tool]: next }));
  }, []);
  const closeSheet = useCallback(() => setSheetAt(null), []);

  const value = useMemo<Shell>(() => {
    const here: Here = { path, query: Object.fromEntries(new URLSearchParams(searchText)) };
    const { tool, menuOf, panel } = toolAt(tools, path);
    const menu = menuOf ? withExtras(menuOf.menu, extras[menuOf.key]) : [];
    const lit = menuOf
      ? activeIn({ to: menuOf.to, menu }, here)
      : { item: null, parent: null, filters: [] };
    return {
      slug,
      tools,
      tool,
      menuOf,
      panel,
      menu,
      lit,
      here,
      collapsed,
      setCollapsed,
      sheetOpen: sheetAt === address,
      openMenu: () => {
        if (panel === "page" || (collapsed && window.matchMedia(DOCKED).matches)) {
          setCollapsed(false);
        } else setSheetAt(address);
      },
      closeSheet,
      setExtras,
    };
  }, [
    slug,
    tools,
    path,
    searchText,
    address,
    extras,
    collapsed,
    sheetAt,
    setCollapsed,
    closeSheet,
    setExtras,
  ]);

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/**
 * What a page has worked out for its tool's panel: counts for rows, and rows
 * for a group the model leaves empty (the help desk's tags). Renders nothing.
 * The panel keeps the last answer while the person stays in the workspace.
 */
export function PanelExtras({ tool, counts, items }: { tool: string } & Extras) {
  const shell = useShell();
  const setExtras = shell?.setExtras;
  const packed = JSON.stringify({ counts, items });
  useEffect(() => {
    setExtras?.(tool, JSON.parse(packed) as Extras);
  }, [setExtras, tool, packed]);
  return null;
}
