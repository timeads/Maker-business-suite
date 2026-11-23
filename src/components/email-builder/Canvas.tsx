"use client";

import { useRef } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { ArrowDown, ArrowUp, GripVertical, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui";
import {
  CONTENT_WIDTH,
  LAYOUT_NAMES,
  LAYOUT_SHARES,
  borderCss,
  type Box,
  type Column,
  type Row,
  type Section,
} from "@/lib/design";
import { cn } from "@/lib/utils";
import { useBuilder } from "./context";
import { useHost } from "./host";
import { CanvasBlock } from "./CanvasBlock";
import type { DragSource, DropTarget } from "./dnd";
import { FOCUS_NAME } from "./shared";

/** Width of the email on a phone, for the Mobile view. */
const PHONE_WIDTH = 375;
// Blocks stay where they are while one is dragged; the line shows where it will land instead.
const stayPut = () => null;
const px = (b: Box) => `${b.top}px ${b.right}px ${b.bottom}px ${b.left}px`;
const hidden = (group: string) =>
  `pointer-events-none opacity-0 focus:pointer-events-auto focus:opacity-100 ${group}`;

/** The line that shows where the dragged thing will land. */
export function InsertLine() {
  return (
    <div
      className="bg-ochre pointer-events-none absolute inset-x-0 -top-px z-40 h-0.5"
      data-insert-line
    >
      <span className="bg-ochre absolute -top-[3px] -left-1 h-2 w-2 rounded-full" />
      <span className="bg-ochre absolute -top-[3px] -right-1 h-2 w-2 rounded-full" />
    </div>
  );
}

/** The space between two rows, where a block gets a row of its own and a row can go. */
function Gap({
  sectionId,
  rowIndex,
  only,
}: {
  sectionId: string;
  rowIndex: number;
  only?: boolean;
}) {
  const { drop } = useBuilder();
  const data: DropTarget = { target: "gap", sectionId, rowIndex, only };
  const { setNodeRef } = useDroppable({ id: `gap:${sectionId}:${rowIndex}`, data });
  const active =
    !!drop && "sectionId" in drop && drop.sectionId === sectionId && drop.rowIndex === rowIndex;
  if (only) {
    return (
      <div
        ref={setNodeRef}
        className={cn(
          "border-border m-3 flex h-20 items-center justify-center rounded border-2 border-dashed text-xs",
          active
            ? "border-ochre bg-ochre/10 text-ochre-text"
            : "border-neutral-300 text-neutral-500",
        )}
      >
        Drop content here
      </div>
    );
  }
  return (
    <div className="relative h-0">
      <div ref={setNodeRef} className="pointer-events-none absolute inset-x-0 -top-2 h-4" />
      {active && <InsertLine />}
    </div>
  );
}

/** The space between two sections, where a section being moved, or a saved one, can go. */
function SectionGap({ index }: { index: number }) {
  const { drop } = useBuilder();
  const data: DropTarget = { target: "sectionGap", index };
  const { setNodeRef } = useDroppable({ id: `sgap:canvas:${index}`, data });
  return (
    <div className="relative h-0">
      <div ref={setNodeRef} className="pointer-events-none absolute inset-x-0 -top-3 h-6" />
      {!!drop && "sectionIndex" in drop && drop.sectionIndex === index && <InsertLine />}
    </div>
  );
}

function ColumnView({
  column,
  columns,
  section,
}: {
  column: Column;
  columns: number;
  section: Section;
}) {
  const { drop } = useBuilder();
  const data: DropTarget = { target: "column", columnId: column.id };
  const { setNodeRef } = useDroppable({
    id: `col:${column.id}`,
    data,
    disabled: column.blocks.length > 0,
  });
  const at = drop && "columnId" in drop && drop.columnId === column.id ? drop.index : -1;
  if (column.blocks.length === 0) {
    return (
      <div
        ref={setNodeRef}
        className={cn(
          "border-border m-2 flex min-h-[72px] items-center justify-center rounded border-2 border-dashed px-2 text-center text-xs",
          at === 0
            ? "border-ochre bg-ochre/10 text-ochre-text"
            : "border-neutral-300 text-neutral-500",
        )}
      >
        Drop content here
      </div>
    );
  }
  return (
    <SortableContext items={column.blocks.map((b) => b.id)} strategy={stayPut}>
      {column.blocks.map((block, i) => (
        <div key={block.id}>
          <div className="relative h-0">{at === i && <InsertLine />}</div>
          <CanvasBlock
            block={block}
            section={section}
            columnId={column.id}
            index={i}
            columns={columns}
          />
        </div>
      ))}
      <div className="relative h-0">{at === column.blocks.length && <InsertLine />}</div>
    </SortableContext>
  );
}

function RowView({ row, section }: { row: Row; section: Section }) {
  const { selection, select, device } = useBuilder();
  const data: DragSource = { source: "row", id: row.id };
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `row:${row.id}`,
    data,
  });
  const shares = LAYOUT_SHARES[row.layout];
  const total = shares.reduce((a, b) => a + b, 0);
  const several = row.columns.length > 1;
  // On a phone the columns stack, unless this row has been told to keep them side by side.
  const sideBySide = several && (device === "desktop" || !row.stackOnMobile);
  const selected = selection?.kind === "row" && selection.id === row.id;
  return (
    <div
      className={cn(
        "group/row relative",
        sideBySide && "flex items-start",
        selected && "outline-ochre z-10 outline outline-2",
        isDragging && "opacity-40",
      )}
      data-row={row.id}
    >
      {/* The row's handle sits in the margin beside the email, so it never lies over the email itself. Click selects the row; drag moves it. */}
      <button
        ref={setNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        data-row-handle
        aria-label={`Row, ${LAYOUT_NAMES[row.layout]}. Click to select, drag to move`}
        title={`Row: ${LAYOUT_NAMES[row.layout].toLowerCase()}. Click to select, drag to move`}
        onClick={(e) => {
          e.stopPropagation();
          select({ kind: "row", id: row.id });
        }}
        className={cn(
          "bg-card text-foreground border-border absolute top-0 right-full z-20 flex h-6 w-6 cursor-grab touch-none items-center justify-center rounded-l border border-r-0 shadow-sm",
          selected
            ? "border-ochre text-ochre-text"
            : hidden("group-hover/row:pointer-events-auto group-hover/row:opacity-100"),
        )}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden />
      </button>
      {row.columns.map((column, i) => (
        <div
          key={column.id}
          className="min-w-0"
          style={{ width: sideBySide ? `${(shares[i] / total) * 100}%` : "100%" }}
          data-column={column.id}
        >
          <ColumnView column={column} columns={row.columns.length} section={section} />
        </div>
      ))}
    </div>
  );
}

function SectionView({
  section,
  index,
  count,
}: {
  section: Section;
  index: number;
  count: number;
}) {
  const { doc, dispatch, selection, select, device, duplicateSection, saveSection } = useBuilder();
  const data: DragSource = { source: "section", id: section.id };
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `section:${section.id}`,
    data,
  });
  const selected = selection?.kind === "section" && selection.id === section.id;
  const s = section.styles;
  const tool =
    "flex h-6 w-6 items-center justify-center rounded border bg-card text-foreground hover:bg-sunken disabled:opacity-40 border-border";
  const { canKeepShared } = useHost();
  const pick = () => select({ kind: "section", id: section.id });
  // Set by Rename in the menu. A closing menu hands the cursor back to its button; for Rename it goes to the name box in the side panel instead.
  const renaming = useRef(false);
  return (
    <section
      aria-label={`${section.name} section`}
      data-section={section.id}
      className={cn(
        "group/section outline-ochre relative outline-1 -outline-offset-1",
        selected ? "outline" : "hover:outline-dashed",
        isDragging && "opacity-40",
      )}
      style={{
        backgroundColor: s.background,
        backgroundImage: s.image ? `url("${s.image}")` : undefined,
        backgroundSize: "cover",
        backgroundPosition: "center",
        ...(s.linkColor ? { ["--eb-link" as string]: s.linkColor } : {}),
      }}
      onClick={(e) => {
        e.stopPropagation();
        pick();
      }}
    >
      <button
        ref={setNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        data-section-tag
        aria-label={`${section.name} section. Click to select, drag to move`}
        title="Click to select, drag to move"
        onClick={(e) => {
          e.stopPropagation();
          pick();
        }}
        className={cn(
          "absolute top-0 left-0 z-20 flex cursor-grab touch-none items-center gap-0.5 rounded-br px-2 py-0.5 text-[11px] font-medium",
          selected
            ? "bg-teal text-on-teal"
            : `bg-card text-ochre-text ${hidden("group-hover/section:pointer-events-auto group-hover/section:opacity-100")}`,
        )}
      >
        {section.name}
        <GripVertical className="h-3 w-3" aria-hidden />
      </button>
      {selected && (
        <div
          className="absolute top-1 right-1 z-20 flex gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className={tool}
            aria-label={`Move the ${section.name} section up`}
            title="Move up"
            disabled={index === 0}
            onClick={() => dispatch({ type: "moveSection", id: section.id, by: -1 })}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={tool}
            aria-label={`Move the ${section.name} section down`}
            title="Move down"
            disabled={index === count - 1}
            onClick={() => dispatch({ type: "moveSection", id: section.id, by: 1 })}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={tool}
                aria-label={`More for the ${section.name} section`}
                title="More"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-44"
              onCloseAutoFocus={(e) => {
                if (!renaming.current) return;
                renaming.current = false;
                e.preventDefault();
                window.dispatchEvent(new CustomEvent(FOCUS_NAME));
              }}
            >
              <DropdownMenuLabel>Section</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  renaming.current = true;
                }}
              >
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => duplicateSection(section.id)}>
                Duplicate
              </DropdownMenuItem>
              {canKeepShared && (
                <DropdownMenuItem onSelect={() => saveSection(section.id)}>Save</DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="text-brick"
                disabled={count < 2}
                onSelect={() => {
                  dispatch({ type: "deleteSection", id: section.id });
                  select(null);
                }}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <div
        className="mx-auto box-border"
        data-section-content
        style={{
          width: device === "mobile" ? PHONE_WIDTH : CONTENT_WIDTH,
          background: s.contentBg ?? doc.globalStyles.contentBg,
          padding: px(s.padding),
          border: borderCss(s.border) || undefined,
        }}
      >
        <Gap sectionId={section.id} rowIndex={0} only={section.rows.length === 0} />
        {section.rows.map((row, i) => (
          <div key={row.id}>
            <RowView row={row} section={section} />
            <Gap sectionId={section.id} rowIndex={i + 1} />
          </div>
        ))}
      </div>
    </section>
  );
}

/** The email itself, laid out to be edited: every section, row, column and block, on the email's own background. */
export function Canvas() {
  const { doc, select } = useBuilder();
  const g = doc.globalStyles;
  return (
    <div
      className="min-h-0 flex-1 overflow-auto"
      style={{
        backgroundColor: g.pageBg,
        backgroundImage: g.pageBgImage ? `url("${g.pageBgImage}")` : undefined,
        backgroundSize: "cover",
        backgroundPosition: "center top",
        ["--eb-link" as string]: g.link.color,
        ["--eb-link-line" as string]: g.link.underline ? "underline" : "none",
        ["--eb-link-weight" as string]: g.link.bold ? "bold" : "inherit",
      }}
      onClick={() => select(null)}
      data-canvas
    >
      <div className="min-w-[660px] pt-8 pb-40">
        <SectionGap index={0} />
        {doc.sections.map((section, i) => (
          <div key={section.id}>
            <SectionView section={section} index={i} count={doc.sections.length} />
            <SectionGap index={i + 1} />
          </div>
        ))}
      </div>
    </div>
  );
}
