"use client";

import { createContext, useContext } from "react";
import type { BlockType, DocAction, EmailDoc, RowLayout, SavedSection } from "@/lib/design";
import type { Drop } from "./dnd";

export type Selection = { kind: "block" | "row" | "section"; id: string } | null;
export type Device = "desktop" | "mobile";

export interface Builder {
  doc: EmailDoc;
  dispatch: (action: DocAction, opts?: { quiet?: boolean }) => void;
  selection: Selection;
  select: (selection: Selection) => void;
  device: Device;
  /** Where the thing being dragged would land if let go now. */
  drop: Drop | null;
  undo: () => void;
  redo: () => void;
  /** Add a new block or row below what is selected, or at the end of the body when nothing is. */
  addBlock: (type: BlockType) => void;
  addRow: (layout: RowLayout) => void;
  duplicateBlock: (id: string) => void;
  /** Select a section and bring it into view. */
  showSection: (id: string) => void;
  duplicateSection: (id: string) => void;
  /** Sections the owner has kept to use again, and what can be done with them. */
  saved: SavedSection[];
  saveSection: (id: string) => void;
  insertSaved: (id: string, index?: number) => void;
  renameSaved: (id: string, name: string) => void;
  deleteSaved: (id: string) => void;
  /** Banners whose picture is being drawn and kept. */
  rendering: ReadonlySet<string>;
  /** Open a banner in the designer. */
  editBanner: (id: string) => void;
}

export const BuilderContext = createContext<Builder | null>(null);

export function useBuilder(): Builder {
  const value = useContext(BuilderContext);
  if (!value) throw new Error("useBuilder is used outside the email builder");
  return value;
}
