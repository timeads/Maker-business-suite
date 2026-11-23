"use client";

import { ArrowLeft, LayoutGrid, Lightbulb, Palette, Rows3, type LucideIcon } from "lucide-react";
import { useMemo } from "react";
import { BLOCK_LABELS, findBlock, findRow, optimize } from "@/lib/design";
import { cn } from "@/lib/utils";
import { useBuilder } from "./context";
import { BlocksPanel } from "./BlocksPanel";
import { StylesPanel } from "./StylesPanel";
import { SectionsPanel } from "./SectionsPanel";
import { OptimizePanel } from "./OptimizePanel";
import { BlockSettings } from "./BlockSettings";
import { RowSettings, SectionSettings } from "./StructureSettings";

export type RailTab = "blocks" | "sections" | "styles" | "optimize";
const TABS: { id: RailTab; label: string; icon: LucideIcon }[] = [
  { id: "blocks", label: "Blocks", icon: LayoutGrid },
  { id: "sections", label: "Sections", icon: Rows3 },
  { id: "styles", label: "Styles", icon: Palette },
  { id: "optimize", label: "Optimize", icon: Lightbulb },
];
const TAB_NAMES: Record<RailTab, string> = {
  blocks: "Blocks",
  sections: "Sections",
  styles: "Email styles",
  optimize: "Optimize",
};

/**
 * The left side of the builder: a narrow rail of tabs, and a panel that shows the tab's
 * contents, or the settings of whatever is selected on the email.
 */
export function SidePanel({ tab, onTab }: { tab: RailTab; onTab: (tab: RailTab) => void }) {
  const { doc, selection, select } = useBuilder();
  // How many findings are more than tips, for the mark on the Optimize tab.
  const toFix = useMemo(() => optimize(doc).filter((s) => s.level !== "tip").length, [doc]);
  const block = selection?.kind === "block" ? findBlock(doc, selection.id)?.block : null;
  const row = selection?.kind === "row" ? findRow(doc, selection.id)?.row : null;
  const section =
    selection?.kind === "section" ? doc.sections.find((s) => s.id === selection.id) : null;
  const title = block
    ? BLOCK_LABELS[block.type]
    : row
      ? "Row"
      : section
        ? `${section.name} section`
        : null;

  return (
    <div className="bg-card border-border flex min-h-0 shrink-0 border-r">
      <nav
        className="border-border flex w-14 shrink-0 flex-col items-center gap-1 border-r py-2"
        aria-label="Builder panels"
      >
        {TABS.map(({ id, label, icon: Icon }) => {
          const on = !title && tab === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              onClick={() => {
                select(null);
                onTab(id);
              }}
              aria-label={id === "optimize" && toFix ? `Optimize: ${toFix} to look at` : label}
              className={cn(
                "focus-visible:outline-ochre relative flex w-12 flex-col items-center gap-0.5 rounded-md py-2 text-[10px] font-medium focus-visible:outline focus-visible:outline-2",
                on
                  ? "bg-ochre/10 text-ochre-text"
                  : "text-muted-foreground hover:bg-sunken hover:text-foreground",
              )}
            >
              <Icon className="h-5 w-5" aria-hidden />
              {label}
              {id === "optimize" && toFix > 0 && (
                <span
                  className="bg-brick absolute top-1 right-1 min-w-[16px] rounded-full px-1 text-center text-[9px] leading-4 font-bold text-white"
                  aria-hidden
                  data-optimize-count
                >
                  {toFix}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <aside
        className="flex min-h-0 w-[272px] flex-col"
        aria-label={title ? `${title} settings` : TAB_NAMES[tab]}
      >
        {title ? (
          <>
            <div className="border-border flex items-center gap-1 border-b px-2 py-2">
              <button
                type="button"
                onClick={() => select(null)}
                aria-label="Back"
                title="Back"
                className="hover:bg-sunken flex h-8 w-8 items-center justify-center rounded"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <h2 className="text-sm font-bold">{title}</h2>
            </div>
            {block && <BlockSettings key={block.id} id={block.id} />}
            {row && (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <RowSettings id={row.id} />
              </div>
            )}
            {section && <SectionSettings key={section.id} id={section.id} />}
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === "blocks" ? (
              <BlocksPanel />
            ) : tab === "sections" ? (
              <SectionsPanel />
            ) : tab === "optimize" ? (
              <OptimizePanel />
            ) : (
              <StylesPanel />
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
