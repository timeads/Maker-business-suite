"use client";

import { useSortable } from "@dnd-kit/sortable";
import { Copy, GripVertical, Move, Trash2 } from "lucide-react";
import { BLOCK_LABELS, spacingOf, type Block, type Box, type Section } from "@/lib/design";
import { cn } from "@/lib/utils";
import { useBuilder } from "./context";
import { BlockView } from "./BlockView";
import type { DragSource, DropTarget } from "./dnd";

const barButton =
  "flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-ochre";
const px = (b: Box) => `${b.top}px ${b.right}px ${b.bottom}px ${b.left}px`;

/**
 * A block on the canvas with everything around it that is not part of the email: the outline
 * and name tag on hover, and the Move, Duplicate and Delete bar once it is selected.
 */
export function CanvasBlock({
  block,
  section,
  columnId,
  index,
  columns,
}: {
  block: Block;
  section: Section;
  columnId: string;
  index: number;
  columns: number;
}) {
  const { doc, dispatch, selection, select, device, duplicateBlock } = useBuilder();
  const data: DragSource & DropTarget = {
    source: "block",
    id: block.id,
    target: "block",
    columnId,
    index,
  };
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, isDragging } = useSortable({
    id: block.id,
    data,
  });
  const selected = selection?.kind === "block" && selection.id === block.id;
  const name = BLOCK_LABELS[block.type];
  // The same spacing the exported email uses, for whichever device the canvas is showing.
  const space = spacingOf(doc, block, columns, device);

  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-label={`${name} block`}
      tabIndex={0}
      data-block={block.id}
      data-block-type={block.type}
      className={cn(
        "group/block outline-ochre relative focus-visible:outline focus-visible:outline-2",
        selected ? "z-10 outline outline-2" : "hover:outline hover:outline-1",
        isDragging && "opacity-40",
      )}
      onClick={(e) => {
        e.stopPropagation();
        select({ kind: "block", id: block.id });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget)
          select({ kind: "block", id: block.id });
      }}
    >
      {/*
        The name tag sits inside the block's own top-right corner, so it never lies over the block
        above, and clear of where a line of text starts. It goes away while the block is typed in.
        Once the block is selected the Move button beside it takes over picking it up with the keyboard.
      */}
      <button
        ref={selected ? undefined : setActivatorNodeRef}
        type="button"
        {...(selected ? {} : attributes)}
        {...listeners}
        tabIndex={selected ? -1 : 0}
        aria-label={`Move ${name.toLowerCase()}`}
        title="Drag to move"
        data-block-tag
        className={cn(
          "bg-teal text-on-teal absolute top-0 right-0 z-20 flex h-4 cursor-grab touch-none items-center gap-0.5 rounded-bl px-1 text-[9px] leading-none font-bold tracking-wide uppercase group-has-[[contenteditable]:focus]/block:hidden",
          // Out of sight until wanted, but still there for the Tab key to reach.
          !selected &&
            "pointer-events-none opacity-0 group-hover/block:pointer-events-auto group-hover/block:opacity-100 focus:pointer-events-auto focus:opacity-100",
        )}
      >
        {name}
        <GripVertical className="h-2.5 w-2.5" aria-hidden />
      </button>

      <div style={{ padding: px(space.margin) }}>
        <div
          style={{
            padding: px(space.padding),
            background: block.type === "spacer" ? undefined : block.styles.background,
          }}
          data-block-box
        >
          <BlockView
            block={block}
            doc={doc}
            section={section}
            device={device}
            selected={selected}
          />
        </div>
      </div>

      {selected && (
        <div
          className="bg-card absolute top-0 left-full z-30 ml-1.5 flex flex-col rounded-md border p-0.5 shadow-md"
          role="toolbar"
          aria-label={`${name} actions`}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            ref={setActivatorNodeRef}
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Move ${name.toLowerCase()}`}
            title="Drag to move, or press Space and use the arrow keys"
            className={cn(barButton, "cursor-grab touch-none")}
          >
            <Move className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={`Duplicate ${name.toLowerCase()}`}
            title="Duplicate"
            className={barButton}
            onClick={() => duplicateBlock(block.id)}
          >
            <Copy className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={`Delete ${name.toLowerCase()}`}
            title="Delete"
            className={cn(barButton, "text-brick")}
            onClick={() => {
              dispatch({ type: "deleteBlock", id: block.id });
              select(null);
            }}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
