"use client";

import { useDraggable } from "@dnd-kit/core";
import {
  BLOCK_LABELS,
  LAYOUT_NAMES,
  LAYOUT_SHARES,
  ROW_LAYOUTS,
  type BlockType,
  type RowLayout,
} from "@/lib/design";
import { useBuilder } from "./context";
import { useHost } from "./host";
import type { DragSource } from "./dnd";
import { BLOCK_ICONS } from "./shared";

// Products need the shop's photo picker, which is not here yet, so they are not offered; one already in an email
// still shows and can be moved, copied or deleted. A banner is drawn in the workspace's brand, so it is offered
// once there is a brand kit to draw it with.
const TILES: BlockType[] = [
  "image",
  "heading",
  "paragraph",
  "button",
  "divider",
  "spacer",
  "banner",
  "footer",
  "social",
  "video",
  "logo",
  "code",
];

/** A small picture of how a row's columns are shared out. */
export function LayoutGlyph({ layout }: { layout: RowLayout }) {
  return (
    <span className="flex h-4 w-8 gap-0.5" aria-hidden>
      {LAYOUT_SHARES[layout].map((share, i) => (
        <span key={i} className="rounded-sm border border-current" style={{ flex: share }} />
      ))}
    </span>
  );
}

function Tile({ type }: { type: BlockType }) {
  const { addBlock } = useBuilder();
  const data: DragSource = { source: "tile", blockType: type };
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `tile:${type}`, data });
  const Icon = BLOCK_ICONS[type];
  return (
    <button
      ref={setNodeRef}
      type="button"
      // Only the pointer starts a drag here, so that Enter and Space still press the button, which adds the block without dragging.
      onPointerDown={listeners?.onPointerDown as React.PointerEventHandler | undefined}
      onClick={() => addBlock(type)}
      data-tile={type}
      title={`Add ${BLOCK_LABELS[type].toLowerCase()}: click, or drag onto the email`}
      className={`bg-card hover:border-foreground/50 focus-visible:outline-ochre flex h-[70px] cursor-grab touch-none flex-col items-center justify-center gap-1.5 rounded-md border text-xs hover:shadow-sm focus-visible:outline focus-visible:outline-2 ${isDragging ? "opacity-50" : ""}`}
    >
      <Icon className="h-5 w-5" aria-hidden />
      {BLOCK_LABELS[type]}
    </button>
  );
}

function Pill({ layout }: { layout: RowLayout }) {
  const { addRow } = useBuilder();
  const data: DragSource = { source: "pill", layout };
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `pill:${layout}`, data });
  return (
    <button
      ref={setNodeRef}
      type="button"
      onPointerDown={listeners?.onPointerDown as React.PointerEventHandler | undefined}
      onClick={() => addRow(layout)}
      data-pill={layout}
      title={`Add a row: ${LAYOUT_NAMES[layout].toLowerCase()}. Click, or drag between rows`}
      className={`bg-card hover:border-foreground/50 focus-visible:outline-ochre flex h-9 cursor-grab touch-none items-center gap-2 rounded-md border px-2.5 text-xs hover:shadow-sm focus-visible:outline focus-visible:outline-2 ${isDragging ? "opacity-50" : ""}`}
    >
      <LayoutGlyph layout={layout} />
      {LAYOUT_NAMES[layout]}
    </button>
  );
}

/** Everything that can be added to the email: content blocks, and rows of columns to put them in. */
export function BlocksPanel() {
  const { kit } = useHost();
  const tiles = kit ? TILES : TILES.filter((t) => t !== "banner");
  return (
    <div className="space-y-6 p-4">
      <div className="space-y-2">
        <div>
          <h2 className="text-sm font-bold">Content blocks</h2>
          <p className="text-muted-foreground text-xs">Drag onto the email, or click to add.</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {tiles.map((t) => (
            <Tile key={t} type={t} />
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <div>
          <h2 className="text-sm font-bold">Columns</h2>
          <p className="text-muted-foreground text-xs">
            Drag between rows to put content side by side.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {ROW_LAYOUTS.map((l) => (
            <Pill key={l} layout={l} />
          ))}
        </div>
      </div>
    </div>
  );
}
