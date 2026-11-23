"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  BLOCK_LABELS,
  LAYOUT_NAMES,
  allBlocks,
  bannerWords,
  cloneSection,
  docChecks,
  docId,
  findBlock,
  findRow,
  findSection,
  newBlock,
  newRow,
  normalizeDoc,
  renderDocHtml,
  type Block,
  type BlockType,
  type EmailDoc,
  type RowLayout,
  type SavedSection,
} from "@/lib/design";
import { bannerDesign } from "@/lib/brand/slides";
import type { SlideDesign } from "@/lib/design/slide-design";
import { BannerDialog } from "./BannerDialog";
import { BuilderContext, type Builder, type Device, type Selection } from "./context";
import { useDocHistory } from "./useDocHistory";
import { useAutosave } from "./useAutosave";
import {
  collision,
  keyboardSteps,
  placeFor,
  sameDrop,
  type DragSource,
  type Drop,
  type DropTarget,
} from "./dnd";
import { TopBar } from "./TopBar";
import { SidePanel, type RailTab } from "./SidePanel";
import { CanvasToolbar } from "./CanvasToolbar";
import { Canvas } from "./Canvas";
import { PreviewDialog } from "./PreviewDialog";
import { LayoutGlyph } from "./BlocksPanel";
import { BLOCK_ICONS, copyText } from "./shared";
import { HostContext, type BuilderHost } from "./host";
import { Toaster, toast } from "./ui";

/** The newest of something, for code that runs later (a key press, a save) without being set up again each time it changes. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** What is being dragged, in words, for screen readers. */
function sourceName(source: DragSource | undefined, doc: EmailDoc, saved: SavedSection[]): string {
  switch (source?.source) {
    case "tile":
      return `new ${BLOCK_LABELS[source.blockType].toLowerCase()}`;
    case "pill":
      return `new row, ${LAYOUT_NAMES[source.layout].toLowerCase()}`;
    case "block":
      return `${BLOCK_LABELS[findBlock(doc, source.id)?.block.type ?? "paragraph"].toLowerCase()} block`;
    case "row":
      return "row";
    case "section":
      return `${findSection(doc, source.id)?.name ?? ""} section`;
    case "saved":
      return `saved section ${saved.find((x) => x.id === source.id)?.name ?? ""}`;
    default:
      return "item";
  }
}

// The card that follows the pointer sits by the pointer, wherever on the block the drag began.
const byPointer: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!draggingNodeRect || !activatorEvent || !("clientX" in activatorEvent)) return transform;
  const e = activatorEvent as PointerEvent;
  return {
    ...transform,
    x: transform.x + e.clientX - draggingNodeRect.left - 16,
    y: transform.y + e.clientY - draggingNodeRect.top - 16,
  };
};

function DragCard({
  source,
  doc,
  saved,
}: {
  source: DragSource;
  doc: EmailDoc;
  saved: SavedSection[];
}) {
  const type =
    source.source === "tile"
      ? source.blockType
      : source.source === "block"
        ? findBlock(doc, source.id)?.block.type
        : null;
  const Icon = type ? BLOCK_ICONS[type] : null;
  const layout =
    source.source === "pill"
      ? source.layout
      : source.source === "row"
        ? findRow(doc, source.id)?.row.layout
        : null;
  const words = type
    ? BLOCK_LABELS[type]
    : source.source === "pill"
      ? LAYOUT_NAMES[source.layout]
      : source.source === "row"
        ? "Row"
        : source.source === "section"
          ? `${findSection(doc, source.id)?.name ?? ""} section`
          : source.source === "saved"
            ? (saved.find((x) => x.id === source.id)?.name ?? "Saved section")
            : "";
  return (
    <div className="bg-card border-border inline-flex cursor-grabbing items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium opacity-90 shadow-lg">
      {Icon ? (
        <Icon className="h-4 w-4" aria-hidden />
      ) : layout ? (
        <LayoutGlyph layout={layout} />
      ) : null}
      {words}
    </div>
  );
}

// The two rules the canvas needs that Tailwind cannot say: the placeholder in an empty text box, and
// links in the email's own link colour. Fixed text, written by us; nothing from the email goes in here.
const CANVAS_CSS = `
.eb-inline:empty::before { content: attr(data-placeholder); opacity: 0.45; }
.eb-inline a { color: var(--eb-link); text-decoration: var(--eb-link-line, underline); font-weight: var(--eb-link-weight, inherit); }
`;

/** The whole builder for one email: top bar, side panel and canvas, with the document, its history and its saving. */
export function EmailBuilder({
  id,
  initial,
  host,
  converted = false,
}: {
  id: string;
  initial: EmailDoc;
  host: BuilderHost;
  converted?: boolean;
}) {
  const router = useRouter();
  // The host may be made afresh each time the page draws; what it does is the same, so the newest is simply used.
  const hostNow = useLatest(host);
  const { doc, dispatch, undo, redo, canUndo, canRedo } = useDocHistory(initial);
  const [picked, select] = useState<Selection>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [tab, setTab] = useState<RailTab>("blocks");
  const [preview, setPreview] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [dragged, setDragged] = useState<DragSource | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [bannerId, setBannerId] = useState<string | null>(null);
  const [rendering, setRendering] = useState<ReadonlySet<string>>(new Set());

  // What is saved is the document made safe and bounded, so a half-typed address never reaches the database.
  const save = (d: EmailDoc) => host.save(normalizeDoc(d));
  const { status, flush } = useAutosave(doc, save);

  // An email kept in the form used before the builder is stored as a document the first time it is opened, so it is only ever converted once.
  const stored = useRef(false);
  useEffect(() => {
    if (!converted || stored.current) return;
    stored.current = true;
    // If this fails nothing is lost: the email is converted again next time, and any change saves it anyway.
    hostNow.current.save(normalizeDoc(initial)).catch(() => undefined);
  }, [converted, initial, hostNow]);

  // Something selected can vanish (undo, delete); then nothing is selected.
  const selection = useMemo<Selection>(() => {
    if (!picked) return null;
    const there =
      picked.kind === "block"
        ? !!findBlock(doc, picked.id)
        : picked.kind === "row"
          ? !!findRow(doc, picked.id)
          : doc.sections.some((s) => s.id === picked.id);
    return there ? picked : null;
  }, [picked, doc]);

  /** Where a click on a tile puts things: below what is selected, else at the end of the body. */
  const rowPlace = useCallback((): { sectionId: string; rowIndex: number } => {
    if (selection?.kind === "block") {
      const at = findBlock(doc, selection.id);
      if (at) return { sectionId: at.section.id, rowIndex: at.r + 1 };
    }
    if (selection?.kind === "row") {
      const at = findRow(doc, selection.id);
      if (at) return { sectionId: at.section.id, rowIndex: at.r + 1 };
    }
    const section =
      (selection?.kind === "section" ? doc.sections.find((s) => s.id === selection.id) : null) ??
      doc.sections.find((s) => s.name.toLowerCase() === "body") ??
      doc.sections[Math.min(1, doc.sections.length - 1)];
    return { sectionId: section.id, rowIndex: section.rows.length };
  }, [doc, selection]);

  /** A new block. A banner starts in the workspace's own colours and lettering, with its own web address. */
  const { kit, makeBanner } = host;
  const makeBlock = useCallback(
    (type: BlockType): Block => {
      const block = newBlock(type, doc.brand);
      if (block.type !== "banner" || !kit) return block;
      return {
        ...block,
        link: kit.site ? `https://${kit.site}` : "",
        design: bannerDesign(kit, { headline: "Your headline" }),
      };
    },
    [doc.brand, kit],
  );

  const addBlock = useCallback(
    (type: BlockType) => {
      const block = makeBlock(type);
      const beside = selection?.kind === "block" ? findBlock(doc, selection.id) : null;
      dispatch({
        type: "insertBlock",
        block,
        at: beside ? { columnId: beside.column.id, index: beside.b + 1 } : rowPlace(),
      });
      select({ kind: "block", id: block.id });
    },
    [doc, selection, dispatch, rowPlace, makeBlock],
  );

  const addRow = useCallback(
    (layout: RowLayout) => {
      const row = newRow(layout);
      const at = rowPlace();
      dispatch({ type: "addRow", row, sectionId: at.sectionId, index: at.rowIndex });
      select({ kind: "row", id: row.id });
    },
    [dispatch, rowPlace],
  );

  const duplicateBlock = useCallback(
    (blockId: string) => {
      const newId = docId("b");
      dispatch({ type: "duplicateBlock", id: blockId, newId });
      select({ kind: "block", id: newId });
    },
    [dispatch],
  );

  /** Select a section and bring it into view. */
  const showSection = useCallback((sectionId: string) => {
    select({ kind: "section", id: sectionId });
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-section="${sectionId}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  }, []);

  const duplicateSection = useCallback(
    (sectionId: string) => {
      const newId = docId("s");
      dispatch({ type: "duplicateSection", id: sectionId, newId });
      showSection(newId);
    },
    [dispatch, showSection],
  );

  /* Saved sections: kept for the workspace, shown at once and put back if storing them fails. */
  const [saved, setSaved] = useState<SavedSection[]>([]);
  useEffect(() => {
    let wanted = true;
    hostNow.current
      .loadSavedSections()
      .then((list) => {
        if (wanted) setSaved(list);
      })
      // Without them the email can still be built; the Saved list is simply empty.
      .catch(() => undefined);
    return () => {
      wanted = false;
    };
  }, [hostNow]);
  const storeSaved = async (next: SavedSection[], done?: string) => {
    const before = saved;
    setSaved(next);
    try {
      await host.storeSavedSections(next);
      if (done) toast.success(done);
    } catch (err) {
      setSaved(before);
      toast.error(
        `Your saved sections could not be updated: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    // Read back, so the list is what was really kept.
    host
      .loadSavedSections()
      .then(setSaved)
      .catch(() => undefined);
  };
  const saveSection = (sectionId: string) => {
    const section = findSection(doc, sectionId);
    if (!section) return;
    if (saved.length >= 40)
      return void toast.error(
        "You have 40 saved sections, which is the most that can be kept. Delete one you no longer use first.",
      );
    storeSaved(
      [{ id: docId("k"), name: section.name, section: cloneSection(section) }, ...saved],
      `"${section.name}" saved. Find it under Sections, then Saved.`,
    );
  };
  const insertSaved = (savedId: string, index?: number) => {
    const item = saved.find((x) => x.id === savedId);
    if (!item) return;
    // Each use is a fresh copy, so the same saved section can go into an email more than once.
    const section = { ...cloneSection(item.section), name: item.name };
    dispatch({ type: "addSection", section, index });
    showSection(section.id);
  };
  const renameSaved = (savedId: string, name: string) =>
    storeSaved(saved.map((x) => (x.id === savedId ? { ...x, name: name.slice(0, 40) } : x)));
  const deleteSaved = (savedId: string) => storeSaved(saved.filter((x) => x.id !== savedId));

  /**
   * Draw a banner's picture and keep it. `changed` says the design has just been edited, so the
   * design and the words read out for it are stored too; a failure is then the caller's to show.
   */
  const renderBanner = useCallback(
    async (blockId: string, design: SlideDesign, changed: boolean) => {
      setRendering((s) => new Set(s).add(blockId));
      try {
        const image = await makeBanner(design);
        if (changed) {
          const words = bannerWords(design);
          dispatch({
            type: "updateBlock",
            id: blockId,
            patch: {
              design,
              image,
              alt: [words.kicker, words.headline, words.badge].filter(Boolean).join(". "),
            },
          });
        } else {
          // A picture that was simply missing is filled in without becoming something to undo.
          dispatch({ type: "updateBlock", id: blockId, patch: { image } }, { quiet: true });
        }
      } catch (err) {
        if (changed) throw err;
        toast.error(
          `The banner picture could not be made: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setRendering((s) => {
          const next = new Set(s);
          next.delete(blockId);
          return next;
        });
      }
    },
    [dispatch, makeBanner],
  );

  // A banner with a design but no picture yet (a new email, one Claude wrote, a banner just
  // added) gets its picture made, once. Without a brand kit there is nothing to draw it with.
  const tried = useRef(new Set<string>());
  useEffect(() => {
    if (!kit) return;
    const waiting = allBlocks(doc).filter(
      (block) => block.type === "banner" && !block.image && !tried.current.has(block.id),
    );
    if (waiting.length === 0) return;
    // After this draw, so the page is on screen (and its typefaces asked for) before any drawing starts.
    const timer = window.setTimeout(() => {
      for (const block of waiting) {
        if (block.type !== "banner" || tried.current.has(block.id)) continue;
        tried.current.add(block.id);
        void renderBanner(block.id, block.design, false);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [doc, renderBanner, kit]);

  const html = () => renderDocHtml(doc);
  const copy = async () => {
    if (await copyText(html())) {
      const checks = docChecks(doc).length;
      toast.success(
        checks
          ? `HTML copied. ${checks} ${checks === 1 ? "thing" : "things"} to check before sending: see Preview.`
          : "HTML copied. Paste it into your email platform.",
      );
    } else {
      toast.error("Copying is blocked in this browser. Use Download instead.");
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([html()], { type: "text/html" }));
    const name =
      (doc.title || doc.meta.subject || "email")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 50) || "email";
    Object.assign(document.createElement("a"), { href: url, download: `${name}.html` }).click();
    URL.revokeObjectURL(url);
  };
  const leave = async () => {
    setExiting(true);
    if (await flush()) {
      router.push(hostNow.current.exitHref);
    } else {
      setExiting(false);
      toast.error(
        "Your changes could not be saved, so the email is still open. Check your connection and try again.",
      );
    }
  };

  // Keyboard shortcuts. They stand aside while something is being typed and while a dialog or menu is open

  const step = (fromId: string, by: -1 | 1) => {
    const ids = allBlocks(doc).map((b) => b.id);
    const next = ids[ids.indexOf(fromId) + by];
    if (!next) return;
    select({ kind: "block", id: next });
    requestAnimationFrame(() =>
      document.querySelector(`[data-block="${next}"]`)?.scrollIntoView({ block: "nearest" }),
    );
  };
  const keys = useLatest({ selection, undo, redo, duplicateBlock, dispatch, step });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A key something else has already acted on (Escape closing a dialog or a menu) is not also a shortcut.
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      // Typing somewhere keeps its keys.
      const typing =
        target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? "");
      if (
        typing ||
        document.querySelector(
          'dialog[open], [role="dialog"][data-state="open"], [role="menu"][data-state="open"]',
        )
      )
        return;
      const k = keys.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && (key === "z" || key === "y")) {
        e.preventDefault();
        if (key === "y" || e.shiftKey) k.redo();
        else k.undo();
        return;
      }
      if (e.key === "Escape") return select(null);
      const sel = k.selection;
      if (!sel) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (sel.kind === "section") return;
        e.preventDefault();
        k.dispatch(
          sel.kind === "block"
            ? { type: "deleteBlock", id: sel.id }
            : { type: "deleteRow", id: sel.id },
        );
        select(null);
      } else if (mod && key === "d" && sel.kind === "block") {
        e.preventDefault();
        k.duplicateBlock(sel.id);
      } else if (
        !e.altKey &&
        !mod &&
        !e.shiftKey &&
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        sel.kind === "block"
      ) {
        // Plain arrows walk the selection through the blocks in reading order.
        e.preventDefault();
        k.step(sel.id, e.key === "ArrowUp" ? -1 : 1);
      } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const by = e.key === "ArrowUp" ? -1 : 1;
        k.dispatch(
          sel.kind === "block"
            ? { type: "nudgeBlock", id: sel.id, by }
            : sel.kind === "row"
              ? { type: "moveRow", id: sel.id, by }
              : { type: "moveSection", id: sel.id, by },
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys]);

  /* Dragging */
  // Which way the arrow keys last moved a picked-up block: 1 down or right, -1 up or left.
  // Kept in a plain holder, which the key handling in dnd.ts writes to.
  const [heading] = useState(() => ({ current: 1 }));
  const coordinateGetter = useMemo(() => keyboardSteps(heading), [heading]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter }),
  );
  const pointerY = useRef<number | null>(null);
  const dropNow = useRef<Drop | null>(null);
  // Where the last drop went, for telling screen readers once it is over.
  const landed = useRef<Drop | null>(null);
  useEffect(() => {
    if (!dragged) return;
    const move = (e: PointerEvent) => {
      pointerY.current = e.clientY;
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [dragged]);

  const setPlace = (place: Drop | null) => {
    if (sameDrop(dropNow.current, place)) return;
    dropNow.current = place;
    setDrop(place);
  };
  const track = (e: DragMoveEvent | DragOverEvent) => {
    const source = e.active.data.current as DragSource | undefined;
    const target = e.over?.data.current as DropTarget | undefined;
    if (!e.over || !target || !source) return setPlace(null);
    // With the keyboard there is no pointer: a block moved down lands below what it reached, one moved up above it.
    const y =
      e.activatorEvent instanceof KeyboardEvent
        ? heading.current > 0
          ? e.over.rect.bottom
          : e.over.rect.top
        : (pointerY.current ?? e.over.rect.top);
    setPlace(placeFor(target, e.over.rect, y));
  };
  const start = (e: DragStartEvent) => {
    pointerY.current =
      "clientY" in e.activatorEvent ? (e.activatorEvent as PointerEvent).clientY : null;
    setDragged((e.active.data.current as DragSource | undefined) ?? null);
  };
  const stop = () => {
    setDragged(null);
    setPlace(null);
  };
  const end = (e: DragEndEvent) => {
    const source = e.active.data.current as DragSource | undefined;
    const at = dropNow.current;
    landed.current = at;
    stop();
    if (!source || !at) return;
    // What can land where is settled while dragging (see `collision`); these checks only keep the types honest.
    if ("sectionIndex" in at) {
      if (source.source === "section") {
        dispatch({ type: "moveSectionTo", id: source.id, index: at.sectionIndex });
        select({ kind: "section", id: source.id });
      } else if (source.source === "saved") insertSaved(source.id, at.sectionIndex);
      return;
    }
    if (source.source === "tile") {
      const block = makeBlock(source.blockType);
      dispatch({ type: "insertBlock", block, at });
      select({ kind: "block", id: block.id });
    } else if (source.source === "pill") {
      if (!("sectionId" in at)) return;
      const row = newRow(source.layout);
      dispatch({ type: "addRow", row, sectionId: at.sectionId, index: at.rowIndex });
      select({ kind: "row", id: row.id });
    } else if (source.source === "row") {
      if (!("sectionId" in at)) return;
      dispatch({ type: "moveRowTo", id: source.id, sectionId: at.sectionId, index: at.rowIndex });
      select({ kind: "row", id: source.id });
    } else if (source.source === "block") {
      dispatch({ type: "moveBlock", id: source.id, to: at });
      select({ kind: "block", id: source.id });
    }
  };
  /** A place in the email in words, for screen readers. */
  const describe = (place: Drop | null): string => {
    if (!place) return "Not over a place to drop.";
    if ("sectionIndex" in place) {
      const after = doc.sections[place.sectionIndex - 1];
      return after ? `After the ${after.name} section.` : "Before the first section.";
    }
    if ("sectionId" in place)
      return `Between rows in the ${doc.sections.find((s) => s.id === place.sectionId)?.name ?? ""} section.`;
    const column = doc.sections
      .flatMap((s) => s.rows)
      .flatMap((r) => r.columns)
      .find((c) => c.id === place.columnId);
    if (!column || column.blocks.length === 0) return "In an empty column.";
    const below = place.index >= column.blocks.length;
    return `${below ? "Below" : "Above"} the ${BLOCK_LABELS[column.blocks[below ? column.blocks.length - 1 : place.index].type].toLowerCase()} block.`;
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up ${sourceName(active.data.current as DragSource | undefined, doc, saved)}. Use the arrow keys to move it, Space to drop it, Escape to cancel.`,
    onDragOver: () => describe(dropNow.current),
    onDragEnd: ({ active }) =>
      landed.current
        ? `Dropped ${sourceName(active.data.current as DragSource | undefined, doc, saved)}. ${describe(landed.current)}`
        : "Dropped where it was. Nothing moved.",
    onDragCancel: () => "Move cancelled.",
  };

  const builder: Builder = {
    doc,
    dispatch,
    selection,
    select,
    device,
    drop,
    undo,
    redo,
    addBlock,
    addRow,
    duplicateBlock,
    showSection,
    duplicateSection,
    saved,
    saveSection,
    insertSaved,
    renameSaved,
    deleteSaved,
    rendering,
    editBanner: setBannerId,
  };
  const banner = bannerId ? findBlock(doc, bannerId)?.block : null;

  return (
    <HostContext.Provider value={host}>
      <BuilderContext.Provider value={builder}>
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          onDragStart={start}
          onDragMove={track}
          onDragOver={track}
          onDragEnd={end}
          onDragCancel={stop}
          accessibility={{
            announcements,
            screenReaderInstructions: {
              draggable:
                "Press Space to pick this up. Then use the arrow keys to move it, Space to drop it, or Escape to cancel.",
            },
          }}
        >
          <div
            className="bg-card text-foreground flex h-dvh flex-col overflow-hidden"
            data-email-builder={id}
          >
            <style href="email-builder-canvas" precedence="default">
              {CANVAS_CSS}
            </style>
            <TopBar
              status={status}
              onRetry={flush}
              onBack={leave}
              onCopy={copy}
              onDownload={download}
              onExit={leave}
              exiting={exiting}
            />
            <div className="flex min-h-0 flex-1">
              <SidePanel tab={tab} onTab={setTab} />
              <div className="flex min-w-0 flex-1 flex-col">
                <CanvasToolbar
                  onDevice={setDevice}
                  onUndo={undo}
                  onRedo={redo}
                  canUndo={canUndo}
                  canRedo={canRedo}
                  onPreview={() => setPreview(true)}
                />
                <Canvas />
              </div>
            </div>
          </div>
          <DragOverlay dropAnimation={null} modifiers={[byPointer]}>
            {dragged && <DragCard source={dragged} doc={doc} saved={saved} />}
          </DragOverlay>
          {preview && <PreviewDialog open onOpenChange={setPreview} />}
          {bannerId && banner?.type === "banner" && (
            <BannerDialog
              key={bannerId}
              design={banner.design}
              onClose={() => setBannerId(null)}
              onUse={async (design) => {
                await renderBanner(bannerId, design, true);
                setBannerId(null);
              }}
            />
          )}
          <Toaster />
        </DndContext>
      </BuilderContext.Provider>
    </HostContext.Provider>
  );
}
