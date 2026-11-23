import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  BadgeCheck,
  Code2,
  GalleryHorizontalEnd,
  PlayCircle,
  Share2,
  Heading,
  ImageIcon,
  Minus,
  MousePointerClick,
  PanelBottom,
  Pilcrow,
  ShoppingBag,
  StretchVertical,
  type LucideIcon,
} from "lucide-react";
import { type Align, type BlockType, type EmailTemplate } from "@/lib/design";

/** Small things several parts of the builder share. */

export const BLOCK_ICONS: Record<BlockType, LucideIcon> = {
  image: ImageIcon,
  heading: Heading,
  paragraph: Pilcrow,
  button: MousePointerClick,
  divider: Minus,
  spacer: StretchVertical,
  banner: GalleryHorizontalEnd,
  products: ShoppingBag,
  footer: PanelBottom,
  code: Code2,
  social: Share2,
  video: PlayCircle,
  logo: BadgeCheck,
};

export const ALIGN_OPTIONS: { value: Align; label: string; Icon: LucideIcon }[] = [
  { value: "left", label: "Left", Icon: AlignLeft },
  { value: "center", label: "Centre", Icon: AlignCenter },
  { value: "right", label: "Right", Icon: AlignRight },
];

export const selectClass =
  "h-9 w-full rounded-sm border border-input bg-card px-2 text-sm text-foreground outline-none focus-visible:border-ochre focus-visible:ring-2 focus-visible:ring-ochre/25";

/** The box on the canvas a text block is typed into, found by the formatting buttons. */
export const inlineBox = (id: string) =>
  document.querySelector<HTMLElement>(`[data-inline="${id}"]`);

/** Sent on the window when the link box of the selected block should be shown and take the cursor. */
export const FOCUS_LINK = "email-builder:focus-link";

/** Sent on the window when the name box of the selected section should take the cursor. */
export const FOCUS_NAME = "email-builder:focus-name";

/** Whether a key press asks for undo or redo (Ctrl or ⌘ with Z, Shift+Z or Y). */
export function undoKey(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): "undo" | "redo" | null {
  const key = e.key.toLowerCase();
  if (!(e.metaKey || e.ctrlKey) || e.altKey || (key !== "z" && key !== "y")) return null;
  return key === "y" || e.shiftKey ? "redo" : "undo";
}

/** Put the typing cursor at the end of a box that is typed into. */
export function caretToEnd(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * Put text on the clipboard. Browsers only allow the modern way on secure pages and with
 * permission, so when it is refused the older way is tried: a hidden box, selected and copied.
 * Resolves to whether the text was copied.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = document.createElement("textarea");
    box.value = text;
    box.setAttribute("readonly", "");
    box.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
    document.body.appendChild(box);
    box.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    box.remove();
    return ok;
  }
}

/** The template with this id, among a brand's starters and the owner's own. */
export const findTemplate = (id: string, starters: EmailTemplate[], saved: EmailTemplate[]) =>
  [...starters, ...saved].find((t) => t.id === id) ?? null;
