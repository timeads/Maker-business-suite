import {
  closestCenter,
  pointerWithin,
  type ClientRect,
  type Collision,
  type CollisionDetection,
  type DroppableContainer,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import type { BlockType, Place, RowLayout } from "@/lib/design";

/**
 * What is being dragged: from the panel, a new block, a new row of columns or a saved section;
 * from the email, a block, a row or a section.
 */
export type DragSource =
  | { source: "tile"; blockType: BlockType }
  | { source: "pill"; layout: RowLayout }
  | { source: "block"; id: string }
  | { source: "row"; id: string }
  | { source: "section"; id: string }
  | { source: "saved"; id: string };

/** What it is over: a block (it lands above or below), an empty column, the space between two rows, or the space between two sections. */
export type DropTarget =
  | { target: "block"; columnId: string; index: number }
  | { target: "column"; columnId: string }
  | { target: "gap"; sectionId: string; rowIndex: number; only?: boolean }
  | { target: "sectionGap"; index: number };

/** Where the dragged thing would land: a place for a block or row, or a gap between sections. */
export type Drop = Place | { sectionIndex: number };

/** What a dragged thing can be dropped on: blocks go among content, rows between rows, sections between sections. */
const wants = (source: DragSource | undefined): "content" | "rows" | "sections" =>
  source?.source === "pill" || source?.source === "row"
    ? "rows"
    : source?.source === "section" || source?.source === "saved"
      ? "sections"
      : "content";

const targetOf = (c: DroppableContainer) =>
  (c.data.current as Partial<DropTarget> | undefined)?.target;

/**
 * The targets nearest the pointer, nearest first. Distance is to the target's edge, so a long
 * thin strip is as easy to hit as a block. Where two strips overlap (the end of one section and
 * the start of the next), the one whose middle is nearer wins.
 */
function nearestToPointer(
  point: { x: number; y: number },
  containers: DroppableContainer[],
  rects: Map<string | number, ClientRect>,
): Collision[] {
  const out: Collision[] = [];
  for (const droppableContainer of containers) {
    const rect = rects.get(droppableContainer.id);
    if (!rect) continue;
    const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
    const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
    const middle = Math.abs(rect.top + rect.height / 2 - point.y);
    out.push({
      id: droppableContainer.id,
      data: { droppableContainer, value: Math.hypot(dx, dy) + middle / 1000 },
    });
  }
  return out.sort((a, b) => (a.data?.value ?? 0) - (b.data?.value ?? 0));
}

/**
 * Which drop target the dragged thing is over. Rows only go between rows and sections between
 * sections, so those take the nearest such gap. A block goes to whatever is under the pointer,
 * the space between rows first, since that strip lies over the edges of the blocks either side;
 * away from everything it goes to whatever is nearest.
 */
export const collision: CollisionDetection = (args) => {
  const kind = wants(args.active.data.current as DragSource | undefined);
  if (kind !== "content") {
    const gaps = args.droppableContainers.filter(
      (c) => targetOf(c) === (kind === "rows" ? "gap" : "sectionGap"),
    );
    return args.pointerCoordinates
      ? nearestToPointer(args.pointerCoordinates, gaps, args.droppableRects)
      : closestCenter({ ...args, droppableContainers: gaps });
  }
  const gaps = args.droppableContainers.filter((c) => targetOf(c) === "gap");
  const rest = args.droppableContainers.filter(
    (c) => (targetOf(c) === "block" || targetOf(c) === "column") && c.id !== args.active.id,
  );
  if (args.pointerCoordinates) {
    const overGap = nearestToPointer(args.pointerCoordinates, gaps, args.droppableRects).filter(
      (c) => (c.data?.value ?? 1) < 0.5,
    );
    if (overGap.length) return overGap;
    const over = pointerWithin({ ...args, droppableContainers: rest });
    if (over.length) return over;
  }
  return closestCenter({ ...args, droppableContainers: [...gaps, ...rest] });
};

/**
 * Moving something picked up with the arrow keys: each press takes it to the next place it can
 * go in that direction, centred on it. For a block that is the next block, empty column or empty
 * section; for a row, the next gap between rows; for a section, the next gap between sections.
 * `heading` records which way the last press went, since a block moved down lands after what it
 * reaches and one moved up before.
 */
export function keyboardSteps(heading: { current: number }): KeyboardCoordinateGetter {
  return (event, { context: { active, collisionRect, droppableContainers, droppableRects } }) => {
    const step = { ArrowDown: [0, 1], ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowLeft: [-1, 0] }[
      event.code
    ];
    if (!step || !active || !collisionRect) return undefined;
    event.preventDefault();
    const kind = wants(active.data.current as DragSource | undefined);
    const from = {
      x: collisionRect.left + collisionRect.width / 2,
      y: collisionRect.top + collisionRect.height / 2,
    };
    let best: { x: number; y: number; far: number } | null = null;
    for (const container of droppableContainers.getEnabled()) {
      const target = container.data.current as DropTarget | undefined;
      const rect = droppableRects.get(container.id);
      if (!rect || !target || container.id === active.id) continue;
      const fits =
        kind === "sections"
          ? target.target === "sectionGap"
          : kind === "rows"
            ? target.target === "gap"
            : target.target === "block" ||
              target.target === "column" ||
              (target.target === "gap" && !!target.only);
      if (!fits) continue;
      const to = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const along = (to.x - from.x) * step[0] + (to.y - from.y) * step[1];
      const across = Math.abs((to.x - from.x) * step[1]) + Math.abs((to.y - from.y) * step[0]);
      // Up and down take the nearest thing above or below; left and right only what is beside.
      if (along <= 1 || (step[0] !== 0 && across > rect.height)) continue;
      const far = along + across / 4;
      if (!best || far < best.far) best = { ...to, far };
    }
    if (!best) return undefined;
    heading.current = step[1] || step[0];
    return { x: best.x - collisionRect.width / 2, y: best.y - collisionRect.height / 2 };
  };
}

/** Where in the email a drop on this target puts things. `y` is how far down the screen the dragged thing is. */
export function placeFor(target: DropTarget, rect: ClientRect, y: number): Drop {
  if (target.target === "sectionGap") return { sectionIndex: target.index };
  if (target.target === "gap") return { sectionId: target.sectionId, rowIndex: target.rowIndex };
  if (target.target === "column") return { columnId: target.columnId, index: 0 };
  return {
    columnId: target.columnId,
    index: y > rect.top + rect.height / 2 ? target.index + 1 : target.index,
  };
}

export const sameDrop = (a: Drop | null, b: Drop | null) => JSON.stringify(a) === JSON.stringify(b);
