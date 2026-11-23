"use client";

import { useLayoutEffect, useRef } from "react";
import { caretToEnd, undoKey } from "./shared";
import { sanitizeInline, type HeadingBlock, type ParagraphBlock } from "@/lib/design";
import { useBuilder } from "./context";

/**
 * A heading or paragraph, typed straight onto the canvas. What is typed is cleaned and sent to
 * the document as it changes; the box itself is left alone while it is being typed in, so the
 * cursor never jumps, and is only rewritten when the text changes from elsewhere (undo, redo).
 */
export function InlineText({
  block,
  style,
}: {
  block: HeadingBlock | ParagraphBlock;
  style: React.CSSProperties;
}) {
  const { dispatch, select, undo, redo } = useBuilder();
  const ref = useRef<HTMLDivElement>(null);
  // What the document held when the box was last in step with it.
  const shown = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || shown.current === block.html) return;
    // Only ever the output of sanitizeInline is written into the page.
    el.innerHTML = sanitizeInline(block.html);
    shown.current = block.html;
    // Rewriting the box drops the cursor; when it is being typed in (an undo mid-sentence), put it back at the end.
    if (document.activeElement === el) caretToEnd(el);
  }, [block.html]);

  const commit = (tidy: boolean) => {
    const el = ref.current;
    if (!el) return;
    const clean = sanitizeInline(el.innerHTML);
    if (tidy && el.innerHTML !== clean) el.innerHTML = clean;
    shown.current = clean;
    dispatch({ type: "updateBlock", id: block.id, patch: { html: clean } });
  };

  return (
    <div
      ref={ref}
      data-inline={block.id}
      role="textbox"
      aria-multiline="true"
      aria-label={block.type === "heading" ? "Heading text" : "Paragraph text"}
      data-placeholder={block.type === "heading" ? "Write a heading" : "Write your text"}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      className="eb-inline min-h-[1em] cursor-text outline-none"
      style={style}
      onFocus={() => select({ kind: "block", id: block.id })}
      onInput={() => commit(false)}
      onBlur={() => commit(true)}
      onBeforeInput={(e) => {
        // Undo chosen from the browser's menu goes the same way as Ctrl+Z: through the builder's one history.
        const kind = (e.nativeEvent as InputEvent).inputType;
        if (kind !== "historyUndo" && kind !== "historyRedo") return;
        e.preventDefault();
        if (kind === "historyUndo") undo();
        else redo();
      }}
      onKeyDown={(e) => {
        const step = undoKey(e);
        if (step) {
          // The builder keeps one history. The browser's own undo for this box would know nothing of blocks moved or styles changed.
          e.preventDefault();
          if (step === "undo") undo();
          else redo();
        } else if (e.key === "Enter") {
          // A line break, not the new paragraph a browser would start: one block is one paragraph.
          e.preventDefault();
          document.execCommand("insertLineBreak");
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      // Dropping content from another page would put its HTML straight into the box, so it is not taken.
      onDrop={(e) => e.preventDefault()}
      onPaste={(e) => {
        // Pasted text comes in plain, so nothing from another page's styling follows it.
        e.preventDefault();
        document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
      }}
    />
  );
}
