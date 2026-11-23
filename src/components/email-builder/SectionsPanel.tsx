"use client";

import { useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Check, GripVertical, Pencil, Plus, Rows3, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui";
import { newSection, type SavedSection, type Section } from "@/lib/design";
import { cn } from "@/lib/utils";
import { useBuilder } from "./context";
import { InsertLine } from "./Canvas";
import type { DragSource, DropTarget } from "./dnd";

const blockCount = (section: Section) =>
  section.rows.reduce((n, r) => n + r.columns.reduce((m, c) => m + c.blocks.length, 0), 0);
const sized = (n: number) => (n === 0 ? "Empty" : n === 1 ? "1 block" : `${n} blocks`);
const grip =
  "flex h-8 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-sunken hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ochre";

/** A place between two sections in the list, where one being dragged can be dropped. */
function ListGap({ index }: { index: number }) {
  const { drop } = useBuilder();
  const data: DropTarget = { target: "sectionGap", index };
  const { setNodeRef } = useDroppable({ id: `sgap:list:${index}`, data });
  return (
    <div className="relative h-0">
      <div ref={setNodeRef} className="pointer-events-none absolute inset-x-0 -top-2 h-4" />
      {!!drop && "sectionIndex" in drop && drop.sectionIndex === index && <InsertLine />}
    </div>
  );
}

function ManageItem({ section }: { section: Section }) {
  const { showSection } = useBuilder();
  const data: DragSource = { source: "section", id: section.id };
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `outline:${section.id}`,
    data,
  });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "bg-card flex items-center gap-1 rounded-md border p-1",
        isDragging && "opacity-40",
      )}
      data-outline={section.id}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        className={grip}
        aria-label={`Move the ${section.name} section`}
        title="Drag to reorder"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => showSection(section.id)}
        className="hover:bg-sunken flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1.5 text-left text-sm"
        title="Select this section"
      >
        <Rows3 className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{section.name}</span>
        <span className="text-muted-foreground shrink-0 text-[11px]">
          {sized(blockCount(section))}
        </span>
      </button>
    </div>
  );
}

function SavedItem({ item }: { item: SavedSection }) {
  const { insertSaved, renameSaved, deleteSaved } = useBuilder();
  const data: DragSource = { source: "saved", id: item.id };
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `saved:${item.id}`,
    data,
  });
  // The name while it is being changed; null when it is not.
  const [name, setName] = useState<string | null>(null);
  const keep = () => {
    if (name !== null && name.trim()) renameSaved(item.id, name.trim());
    setName(null);
  };
  return (
    <li
      ref={setNodeRef}
      className={cn("bg-card space-y-1 rounded-md border p-1", isDragging && "opacity-40")}
      data-saved={item.id}
    >
      <div className="flex items-center gap-1">
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          className={grip}
          aria-label={`Drag ${item.name} onto the email`}
          title="Drag onto the email, between sections"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        {name === null ? (
          <button
            type="button"
            onClick={() => insertSaved(item.id)}
            className="hover:bg-sunken flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1.5 text-left text-sm"
            title="Add to the end of the email"
          >
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            <span className="text-muted-foreground shrink-0 text-[11px]">
              {sized(blockCount(item.section))}
            </span>
          </button>
        ) : (
          <Input
            autoFocus
            aria-label="Saved section name"
            className="h-8 flex-1 text-sm"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            onBlur={keep}
            onKeyDown={(e) => {
              if (e.key === "Enter") keep();
              if (e.key === "Escape") setName(null);
            }}
          />
        )}
        {name === null ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 px-0"
            aria-label={`Rename ${item.name}`}
            title="Rename"
            onClick={() => setName(item.name)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 px-0"
            aria-label="Keep this name"
            title="Keep this name"
            onMouseDown={(e) => e.preventDefault()}
            onClick={keep}
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-brick h-8 w-8 px-0"
          aria-label={`Delete ${item.name}`}
          title="Delete"
          onClick={() => {
            if (
              window.confirm(
                `Delete the saved section "${item.name}"? Emails that already use it keep their copy.`,
              )
            )
              deleteSaved(item.id);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </li>
  );
}

/** The email's sections as a list to reorder and add to, and the sections kept to use again. */
export function SectionsPanel() {
  const { doc, dispatch, saved, showSection } = useBuilder();
  const add = () => {
    const section = newSection("New section");
    dispatch({ type: "addSection", section });
    showSection(section.id);
  };
  return (
    <div className="p-4">
      <h2 className="text-sm font-bold">Email sections</h2>
      <p className="text-muted-foreground text-xs">
        The parts your email is made of. Reorder them, add one, or put in one you saved earlier.
      </p>
      <Tabs defaultValue="manage" className="mt-3">
        <TabsList className="grid h-9 grid-cols-2">
          <TabsTrigger value="manage" className="text-xs">
            Manage
          </TabsTrigger>
          <TabsTrigger value="saved" className="text-xs">
            Saved
          </TabsTrigger>
        </TabsList>
        <TabsContent value="manage" className="space-y-3">
          <ul className="space-y-1.5" aria-label="Sections in this email">
            {doc.sections.map((section, i) => (
              <li key={section.id}>
                <ListGap index={i} />
                <ManageItem section={section} />
              </li>
            ))}
            <li aria-hidden>
              <ListGap index={doc.sections.length} />
            </li>
          </ul>
          <Button type="button" variant="outline" size="sm" className="w-full" onClick={add}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add blank section
          </Button>
          <p className="text-muted-foreground text-[11px]">
            Click a section to select it. Drag by the dots to reorder.
          </p>
        </TabsContent>
        <TabsContent value="saved" className="space-y-3">
          {saved.length === 0 ? (
            <p className="text-muted-foreground rounded-md border border-dashed p-4 text-center text-xs">
              Nothing saved yet. Select a section on the email, open its More menu (three dots) and
              choose Save.
            </p>
          ) : (
            <ul className="space-y-1.5" aria-label="Saved sections">
              {saved.map((item) => (
                <SavedItem key={item.id} item={item} />
              ))}
            </ul>
          )}
          {saved.length > 0 && (
            <p className="text-muted-foreground text-[11px]">
              Click one to add it to the end of the email, or drag it between sections.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
