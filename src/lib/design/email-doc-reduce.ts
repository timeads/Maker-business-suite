// Every change to an email document, as one pure function. The builder sends each change here,
// which is what lets undo, redo and saving all work from a single place.
//
// A change that would alter nothing returns the same document, so callers can tell and skip
// recording an empty undo step.

import {
  LAYOUT_SHARES,
  cloneSection,
  docId,
  findBlock,
  findRow,
  isStyled,
  newRow,
  plainSectionStyles,
  plainStyles,
  sanitizeInline,
  type Block,
  type BlockStyles,
  type Column,
  type EmailDoc,
  type GlobalStyles,
  type Row,
  type RowLayout,
  type Section,
  type SectionStyles,
} from "./email-doc";
import { sanitizeHtml } from "./html-sanitize";

/**
 * Where a block can be put: at a position in a column, or between two rows of a section, where
 * it gets a new one-column row of its own.
 */
export type Place = { columnId: string; index: number } | { sectionId: string; rowIndex: number };

export type DocAction =
  | { type: "insertBlock"; block: Block; at: Place }
  | { type: "moveBlock"; id: string; to: Place }
  | { type: "nudgeBlock"; id: string; by: -1 | 1 }
  | { type: "duplicateBlock"; id: string; newId: string }
  | { type: "deleteBlock"; id: string }
  | { type: "updateBlock"; id: string; patch: Record<string, unknown> }
  | { type: "updateBlockStyles"; id: string; patch: Partial<BlockStyles> }
  | { type: "clearBlockStyles"; id: string }
  | { type: "addRow"; row: Row; sectionId: string; index: number }
  | { type: "moveRow"; id: string; by: -1 | 1 }
  | { type: "moveRowTo"; id: string; sectionId: string; index: number }
  | { type: "setRowStack"; id: string; stack: boolean }
  | { type: "deleteRow"; id: string }
  | { type: "setRowLayout"; id: string; layout: RowLayout }
  | { type: "setGlobalStyles"; patch: Partial<GlobalStyles> }
  | { type: "setMeta"; patch: Partial<EmailDoc["meta"]> }
  | { type: "setTitle"; title: string }
  | { type: "setPlatform"; platform: EmailDoc["platform"] }
  | { type: "addSection"; section: Section; index?: number }
  | { type: "renameSection"; id: string; name: string }
  | { type: "moveSection"; id: string; by: -1 | 1 }
  | { type: "moveSectionTo"; id: string; index: number }
  | { type: "duplicateSection"; id: string; newId: string }
  | { type: "updateSectionStyles"; id: string; patch: Partial<SectionStyles> }
  | { type: "clearSectionStyles"; id: string }
  | { type: "deleteSection"; id: string }
  | { type: "applyTemplate"; globalStyles: GlobalStyles; sections: Section[] };

const mapColumns = (doc: EmailDoc, fn: (column: Column) => Column): EmailDoc => {
  let changed = false;
  const sections = doc.sections.map((section) => {
    let sectionChanged = false;
    const rows = section.rows.map((row) => {
      let rowChanged = false;
      const columns = row.columns.map((column) => {
        const next = fn(column);
        if (next !== column) rowChanged = true;
        return next;
      });
      if (rowChanged) sectionChanged = true;
      return rowChanged ? { ...row, columns } : row;
    });
    if (sectionChanged) changed = true;
    return sectionChanged ? { ...section, rows } : section;
  });
  return changed ? { ...doc, sections } : doc;
};

const mapSection = (doc: EmailDoc, id: string, fn: (section: Section) => Section): EmailDoc => {
  let changed = false;
  const sections = doc.sections.map((s) => {
    if (s.id !== id) return s;
    const next = fn(s);
    if (next !== s) changed = true;
    return next;
  });
  return changed ? { ...doc, sections } : doc;
};

const mapBlock = (doc: EmailDoc, id: string, fn: (block: Block) => Block): EmailDoc =>
  mapColumns(doc, (column) => {
    const at = column.blocks.findIndex((b) => b.id === id);
    if (at < 0) return column;
    const next = fn(column.blocks[at]);
    return next === column.blocks[at]
      ? column
      : { ...column, blocks: column.blocks.map((b, i) => (i === at ? next : b)) };
  });

const without = (doc: EmailDoc, id: string): EmailDoc =>
  mapColumns(doc, (column) =>
    column.blocks.some((b) => b.id === id)
      ? { ...column, blocks: column.blocks.filter((b) => b.id !== id) }
      : column,
  );

function put(doc: EmailDoc, block: Block, at: Place): EmailDoc {
  if ("columnId" in at) {
    return mapColumns(doc, (column) => {
      if (column.id !== at.columnId) return column;
      const index = Math.max(0, Math.min(column.blocks.length, at.index));
      return {
        ...column,
        blocks: [...column.blocks.slice(0, index), block, ...column.blocks.slice(index)],
      };
    });
  }
  return mapSection(doc, at.sectionId, (section) => {
    const index = Math.max(0, Math.min(section.rows.length, at.rowIndex));
    return {
      ...section,
      rows: [...section.rows.slice(0, index), newRow("1", [block]), ...section.rows.slice(index)],
    };
  });
}

/** A one-column row that has been emptied is only clutter, so it goes. Rows of several columns stay, to be filled again. */
const dropIfSpent = (doc: EmailDoc, rowId: string): EmailDoc => {
  const found = findRow(doc, rowId);
  if (!found || found.row.layout !== "1" || found.row.columns[0].blocks.length > 0) return doc;
  return mapSection(doc, found.section.id, (s) => ({
    ...s,
    rows: s.rows.filter((r) => r.id !== rowId),
  }));
};

const placeExists = (doc: EmailDoc, at: Place) =>
  "columnId" in at
    ? doc.sections.some((s) => s.rows.some((r) => r.columns.some((c) => c.id === at.columnId)))
    : doc.sections.some((s) => s.id === at.sectionId);

function moveBlock(doc: EmailDoc, id: string, to: Place): EmailDoc {
  const from = findBlock(doc, id);
  if (!from || !placeExists(doc, to)) return doc;
  const alone = from.row.layout === "1" && from.column.blocks.length === 1;
  if ("columnId" in to) {
    if (to.columnId === from.column.id) {
      // Dropping a block just above or just below itself leaves it where it is.
      if (to.index === from.b || to.index === from.b + 1) return doc;
      return put(without(doc, id), from.block, {
        columnId: to.columnId,
        index: to.index > from.b ? to.index - 1 : to.index,
      });
    }
  } else if (
    alone &&
    to.sectionId === from.section.id &&
    (to.rowIndex === from.r || to.rowIndex === from.r + 1)
  ) {
    return doc;
  }
  return dropIfSpent(put(without(doc, id), from.block, to), from.row.id);
}

/** Move a block one step up or down the email, as the arrow keys do. */
function nudgeBlock(doc: EmailDoc, id: string, by: -1 | 1): EmailDoc {
  const from = findBlock(doc, id);
  if (!from) return doc;
  const target = from.b + by;
  if (target >= 0 && target < from.column.blocks.length)
    return moveBlock(doc, id, { columnId: from.column.id, index: by < 0 ? target : target + 1 });
  const alone = from.row.layout === "1" && from.column.blocks.length === 1;
  // A block at the edge of a row of columns steps out into a row of its own.
  if (!alone)
    return moveBlock(doc, id, {
      sectionId: from.section.id,
      rowIndex: by < 0 ? from.r : from.r + 1,
    });
  const row = from.r + by;
  if (row >= 0 && row < from.section.rows.length)
    return moveBlock(doc, id, { sectionId: from.section.id, rowIndex: by < 0 ? row : row + 1 });
  const next = doc.sections[from.s + by];
  if (!next) return doc;
  return moveBlock(doc, id, { sectionId: next.id, rowIndex: by < 0 ? next.rows.length : 0 });
}

function moveRow(doc: EmailDoc, id: string, by: -1 | 1): EmailDoc {
  const from = findRow(doc, id);
  if (!from) return doc;
  const target = from.r + by;
  if (target >= 0 && target < from.section.rows.length) {
    return mapSection(doc, from.section.id, (s) => {
      const rows = [...s.rows];
      [rows[from.r], rows[target]] = [rows[target], rows[from.r]];
      return { ...s, rows };
    });
  }
  const next = doc.sections[from.s + by];
  if (!next) return doc;
  const taken = mapSection(doc, from.section.id, (s) => ({
    ...s,
    rows: s.rows.filter((r) => r.id !== id),
  }));
  return mapSection(taken, next.id, (s) => ({
    ...s,
    rows: by < 0 ? [...s.rows, from.row] : [from.row, ...s.rows],
  }));
}

/** Put a row between two rows of any section. `index` counts the rows of that section as they are before the move. */
function moveRowTo(doc: EmailDoc, id: string, sectionId: string, index: number): EmailDoc {
  const from = findRow(doc, id);
  const target = doc.sections.find((s) => s.id === sectionId);
  if (!from || !target) return doc;
  const same = from.section.id === sectionId;
  // Dropping a row just above or just below itself leaves it where it is.
  if (same && (index === from.r || index === from.r + 1)) return doc;
  const taken = mapSection(doc, from.section.id, (s) => ({
    ...s,
    rows: s.rows.filter((r) => r.id !== id),
  }));
  return mapSection(taken, sectionId, (s) => {
    const at = Math.max(0, Math.min(s.rows.length, same && index > from.r ? index - 1 : index));
    return { ...s, rows: [...s.rows.slice(0, at), from.row, ...s.rows.slice(at)] };
  });
}

function setRowLayout(doc: EmailDoc, id: string, layout: RowLayout): EmailDoc {
  const from = findRow(doc, id);
  if (!from || from.row.layout === layout || !LAYOUT_SHARES[layout]) return doc;
  const count = LAYOUT_SHARES[layout].length;
  const kept = from.row.columns.slice(0, count);
  // Blocks in columns that are going away move into the last column that stays, so nothing is lost.
  const spare = from.row.columns.slice(count).flatMap((c) => c.blocks);
  const columns: Column[] = kept.map((c, i) =>
    i === kept.length - 1 && spare.length ? { ...c, blocks: [...c.blocks, ...spare] } : c,
  );
  while (columns.length < count) columns.push({ id: docId("c"), blocks: [] });
  return mapSection(doc, from.section.id, (s) => ({
    ...s,
    rows: s.rows.map((r) => (r.id === id ? { ...r, layout, columns } : r)),
  }));
}

export function reduceDoc(doc: EmailDoc, action: DocAction): EmailDoc {
  switch (action.type) {
    case "insertBlock":
      return findBlock(doc, action.block.id) ? doc : put(doc, action.block, action.at);
    case "moveBlock":
      return moveBlock(doc, action.id, action.to);
    case "nudgeBlock":
      return nudgeBlock(doc, action.id, action.by);
    case "duplicateBlock": {
      const from = findBlock(doc, action.id);
      if (!from || findBlock(doc, action.newId)) return doc;
      const copy = { ...(JSON.parse(JSON.stringify(from.block)) as Block), id: action.newId };
      return put(doc, copy, { columnId: from.column.id, index: from.b + 1 });
    }
    case "deleteBlock": {
      const from = findBlock(doc, action.id);
      return from ? dropIfSpent(without(doc, action.id), from.row.id) : doc;
    }
    case "updateBlock":
      return mapBlock(doc, action.id, (block) => {
        const patch = { ...action.patch };
        // Formatted text is made safe on its way in, whoever sends it.
        if (typeof patch.html === "string")
          patch.html =
            block.type === "code" ? sanitizeHtml(patch.html).html : sanitizeInline(patch.html);
        const same = Object.keys(patch).every(
          (k) => (block as unknown as Record<string, unknown>)[k] === patch[k],
        );
        return same
          ? block
          : ({ ...block, ...patch, id: block.id, type: block.type, styles: block.styles } as Block);
      });
    case "updateBlockStyles":
      return mapBlock(doc, action.id, (block) => {
        const styles: BlockStyles = { ...plainStyles(), ...block.styles, ...action.patch };
        // A style set back to nothing is removed, so the block follows the email's styles again.
        for (const key of Object.keys(styles) as (keyof BlockStyles)[])
          if (styles[key] === undefined) delete styles[key];
        if (styles.mobile && Object.keys(styles.mobile).length === 0) delete styles.mobile;
        return JSON.stringify(styles) === JSON.stringify(block.styles)
          ? block
          : {
              ...block,
              styles: {
                ...styles,
                sameForMobile: styles.sameForMobile ?? true,
                desktop: styles.desktop ?? {},
              },
            };
      });
    case "clearBlockStyles":
      return mapBlock(doc, action.id, (block) =>
        isStyled(block.styles) ? { ...block, styles: plainStyles() } : block,
      );
    case "addRow":
      return findRow(doc, action.row.id)
        ? doc
        : mapSection(doc, action.sectionId, (s) => {
            const index = Math.max(0, Math.min(s.rows.length, action.index));
            return { ...s, rows: [...s.rows.slice(0, index), action.row, ...s.rows.slice(index)] };
          });
    case "moveRow":
      return moveRow(doc, action.id, action.by);
    case "moveRowTo":
      return moveRowTo(doc, action.id, action.sectionId, action.index);
    case "setRowStack": {
      const from = findRow(doc, action.id);
      if (!from || from.row.stackOnMobile === action.stack) return doc;
      return mapSection(doc, from.section.id, (s) => ({
        ...s,
        rows: s.rows.map((r) => (r.id === action.id ? { ...r, stackOnMobile: action.stack } : r)),
      }));
    }
    case "deleteRow": {
      const from = findRow(doc, action.id);
      return from
        ? mapSection(doc, from.section.id, (s) => ({
            ...s,
            rows: s.rows.filter((r) => r.id !== action.id),
          }))
        : doc;
    }
    case "setRowLayout":
      return setRowLayout(doc, action.id, action.layout);
    case "setGlobalStyles":
      return { ...doc, globalStyles: { ...doc.globalStyles, ...action.patch } };
    case "setMeta": {
      const meta = { ...doc.meta, ...action.patch };
      return meta.subject === doc.meta.subject && meta.previewText === doc.meta.previewText
        ? doc
        : { ...doc, meta };
    }
    case "setTitle":
      return action.title === doc.title ? doc : { ...doc, title: action.title };
    case "setPlatform":
      return action.platform === doc.platform ? doc : { ...doc, platform: action.platform };
    case "addSection": {
      if (doc.sections.some((s) => s.id === action.section.id)) return doc;
      const index = Math.max(0, Math.min(doc.sections.length, action.index ?? doc.sections.length));
      return {
        ...doc,
        sections: [...doc.sections.slice(0, index), action.section, ...doc.sections.slice(index)],
      };
    }
    case "renameSection":
      return mapSection(doc, action.id, (s) =>
        s.name === action.name || !action.name.trim()
          ? s
          : { ...s, name: action.name.slice(0, 40) },
      );
    case "moveSection": {
      const at = doc.sections.findIndex((s) => s.id === action.id);
      const to = at + action.by;
      if (at < 0 || to < 0 || to >= doc.sections.length) return doc;
      const sections = [...doc.sections];
      [sections[at], sections[to]] = [sections[to], sections[at]];
      return { ...doc, sections };
    }
    case "moveSectionTo": {
      const at = doc.sections.findIndex((s) => s.id === action.id);
      // `index` is the gap the section is dropped in, counted before it is lifted out; the gaps either side of it change nothing.
      if (at < 0 || action.index === at || action.index === at + 1) return doc;
      const rest = doc.sections.filter((s) => s.id !== action.id);
      const to = Math.max(
        0,
        Math.min(rest.length, action.index > at ? action.index - 1 : action.index),
      );
      return { ...doc, sections: [...rest.slice(0, to), doc.sections[at], ...rest.slice(to)] };
    }
    case "duplicateSection": {
      const at = doc.sections.findIndex((s) => s.id === action.id);
      if (at < 0 || doc.sections.some((s) => s.id === action.newId)) return doc;
      const copy = {
        ...cloneSection(doc.sections[at], action.newId),
        name: `${doc.sections[at].name} copy`.slice(0, 40),
      };
      return {
        ...doc,
        sections: [...doc.sections.slice(0, at + 1), copy, ...doc.sections.slice(at + 1)],
      };
    }
    case "updateSectionStyles":
      return mapSection(doc, action.id, (s) => {
        const styles: SectionStyles = { ...s.styles, ...action.patch };
        for (const key of Object.keys(styles) as (keyof SectionStyles)[])
          if (styles[key] === undefined) delete styles[key];
        return JSON.stringify(styles) === JSON.stringify(s.styles)
          ? s
          : { ...s, styles: { ...plainSectionStyles(), ...styles } };
      });
    case "clearSectionStyles":
      return mapSection(doc, action.id, (s) =>
        JSON.stringify(s.styles) === JSON.stringify(plainSectionStyles())
          ? s
          : { ...s, styles: plainSectionStyles() },
      );
    case "applyTemplate": {
      if (action.sections.length === 0) return doc;
      // The template's structure and look replace the email's. Its subject, name and platform stay, and so does its logo where the template has none.
      const logo = action.globalStyles.logo.src
        ? action.globalStyles.logo
        : { ...action.globalStyles.logo, src: doc.globalStyles.logo.src };
      return {
        ...doc,
        globalStyles: { ...action.globalStyles, logo },
        sections: action.sections.map((section) => cloneSection(section)),
      };
    }
    case "deleteSection":
      // The last section stays, so there is always somewhere to put things.
      return doc.sections.length > 1 && doc.sections.some((s) => s.id === action.id)
        ? { ...doc, sections: doc.sections.filter((s) => s.id !== action.id) }
        : doc;
    default:
      return doc;
  }
}
