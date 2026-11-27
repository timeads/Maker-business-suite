"use client";

import { useState, useTransition } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { moveTo } from "@/lib/dashboard/debt/order";
import { moveDebt } from "./debt-actions";

export type OrderItem = { id: string; name: string; detail: string };

/**
 * "Your own order": the pool's debts, first to last. A debt moves by
 * dragging it, by its up and down buttons, or by picking its number; each
 * applies at once through `move_money_debt` (the others shift around it),
 * and the list shows the new order straight away. Owners and admins only.
 */
export function DebtOrder({
  slug,
  items,
  following,
  canEdit,
}: {
  slug: string;
  items: OrderItem[];
  /** The order the plan follows now, in words, when it isn't the person's own. */
  following: string | null;
  canEdit: boolean;
}) {
  const [list, setList] = useState(items);
  const [said, setSaid] = useState<{ error?: string; message?: string }>({});
  const [pending, start] = useTransition();
  // A fresh order from the server (after a move or another change) wins.
  const key = items.map((i) => i.id).join(",");
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setList(items);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const place = (id: string, position: number) => {
    const at = list.findIndex((i) => i.id === id);
    if (at < 0 || position === at + 1) return;
    const before = list;
    setList(moveTo(list, at, position));
    start(async () => {
      const done = await moveDebt(slug, id, position);
      if (done.error && done.place === undefined) setList(before);
      setSaid(done);
    });
  };

  const nameOf = (id: unknown) => list.find((i) => i.id === id)?.name ?? "the debt";
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up ${nameOf(active.id)}. Use the up and down arrows to move it, Space to drop it, Escape to cancel.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${nameOf(active.id)} would be number ${list.findIndex((i) => i.id === over.id) + 1}.`
        : "Not over the list.",
    onDragEnd: ({ active, over }) =>
      over
        ? `${nameOf(active.id)} is number ${list.findIndex((i) => i.id === over.id) + 1} now.`
        : "Dropped where it was.",
    onDragCancel: () => "Move cancelled. Nothing changed.",
  };
  const end = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    place(String(active.id), list.findIndex((i) => i.id === over.id) + 1);
  };

  return (
    <div className="flex flex-col gap-3">
      {following && canEdit && (
        <p className="text-muted-foreground text-sm">
          The plan follows {following} now. Moving a debt here switches it to your own order, the
          way &ldquo;Use this order&rdquo; would.
        </p>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={end}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              "Press Space to pick this debt up. Then use the up and down arrows to move it, Space to drop it, or Escape to cancel.",
          },
        }}
      >
        <SortableContext items={list.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <ol className="flex flex-col gap-1.5" aria-label="Your own order" aria-busy={pending}>
            {list.map((item, i) => (
              <OrderRow
                key={item.id}
                item={item}
                index={i}
                count={list.length}
                canEdit={canEdit}
                pending={pending}
                onPlace={(position) => place(item.id, position)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      {(said.error || said.message) && (
        <span
          role={said.error ? "alert" : "status"}
          className={`text-sm ${said.error ? "text-brick" : "text-muted-foreground"}`}
        >
          {said.error ?? said.message}
        </span>
      )}
    </div>
  );
}

function OrderRow({
  item,
  index,
  count,
  canEdit,
  pending,
  onPlace,
}: {
  item: OrderItem;
  index: number;
  count: number;
  canEdit: boolean;
  pending: boolean;
  onPlace: (position: number) => void;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !canEdit,
  });
  const style = {
    transform: transform
      ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`
      : undefined,
    transition,
  };
  const n = index + 1;
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`border-border bg-card flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm ${isDragging ? "ring-teal/40 relative z-10 ring-2" : ""}`}
    >
      {canEdit && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground cursor-grab touch-none px-1 active:cursor-grabbing"
          aria-label={`Drag ${item.name} to a new place`}
          {...attributes}
          {...listeners}
        >
          <span aria-hidden>⋮⋮</span>
        </button>
      )}
      <span className="w-6 text-right font-semibold tabular-nums">{n}</span>
      <span className="min-w-0 flex-1">
        <span className="font-medium">{item.name}</span>
        <span className="text-muted-foreground block text-xs">{item.detail}</span>
      </span>
      {canEdit && (
        <span className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending || n === 1}
            aria-label={`Move ${item.name} up`}
            onClick={() => onPlace(n - 1)}
          >
            ↑
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending || n === count}
            aria-label={`Move ${item.name} down`}
            onClick={() => onPlace(n + 1)}
          >
            ↓
          </Button>
          <label className="sr-only" htmlFor={`place-${item.id}`}>
            Place for {item.name}
          </label>
          <Select
            id={`place-${item.id}`}
            className="h-8 w-16 py-0 tabular-nums"
            value={n}
            disabled={pending}
            onChange={(e) => onPlace(Number(e.target.value))}
          >
            {Array.from({ length: count }, (_, k) => (
              <option key={k + 1} value={k + 1}>
                {k + 1}
              </option>
            ))}
          </Select>
        </span>
      )}
    </li>
  );
}
