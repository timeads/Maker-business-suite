import { isSafeLink, tidyDoc, type RichBlock, type RichDoc, type RichRun } from "./rich";

/**
 * Reading a `contentEditable` box into the suite's small document. Used by
 * the reply box and by the manual's editor, in the browser only. Whatever
 * the browser put in the box, only our own short list of marks comes out.
 */

type Marks = Omit<RichRun, "text">;
const BLOCKS = new Set(["P", "DIV", "UL", "OL", "LI", "BLOCKQUOTE", "H1", "H2", "H3", "PRE"]);

/** Reads what is typed into a document of our own kind; tags we don't know are just their text. */
export function readEditor(root: HTMLElement): RichDoc {
  const doc: RichDoc = [];
  let open: RichRun[] | null = null;
  const para = () => {
    if (!open) {
      open = [];
      doc.push({ t: "p", runs: open });
    }
    return open;
  };
  const inline = (node: Node, marks: Marks, into: () => RichRun[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/ /g, " ");
      if (text) into().push({ text, ...marks });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName;
    if (tag === "BR") {
      into().push({ text: "\n", ...marks });
      return;
    }
    const next: Marks = { ...marks };
    if (tag === "B" || tag === "STRONG") next.b = true;
    if (tag === "I" || tag === "EM") next.i = true;
    if (tag === "U") next.u = true;
    if (tag === "S" || tag === "STRIKE" || tag === "DEL") next.s = true;
    if (tag === "A") {
      const href = node.getAttribute("href") ?? "";
      if (isSafeLink(href)) next.href = href.trim();
    }
    for (const child of node.childNodes) walk(child, next, into);
  };
  const walk = (node: Node, marks: Marks, into: () => RichRun[]) => {
    if (node instanceof HTMLElement && (node.tagName === "UL" || node.tagName === "OL")) {
      const items: RichRun[][] = [];
      for (const li of node.children) {
        const item: RichRun[] = [];
        for (const child of li.childNodes) inline(child, marks, () => item);
        items.push(item);
      }
      const block: RichBlock = { t: node.tagName === "UL" ? "ul" : "ol", items };
      doc.push(block);
      open = null;
      return;
    }
    if (node instanceof HTMLElement && BLOCKS.has(node.tagName)) {
      open = null;
      for (const child of node.childNodes) walk(child, marks, into);
      open = null;
      return;
    }
    inline(node, marks, into);
  };
  for (const child of root.childNodes) walk(child, {}, para);
  // A line break that only ends a paragraph isn't part of its words.
  for (const block of doc) {
    if (block.t === "p") {
      const last = block.runs[block.runs.length - 1];
      if (last && last.text === "\n") block.runs.pop();
    }
  }
  return tidyDoc(doc);
}
