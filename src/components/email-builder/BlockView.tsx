"use client";

import { useLayoutEffect, useRef } from "react";
import { BadgeCheck, Code2, ImageIcon, Link2, PlayCircle, Share2, ShoppingBag } from "lucide-react";
import {
  FONTS,
  SOCIAL_NETWORKS,
  bannerWords,
  borderCss,
  buttonLook,
  imageLook,
  linkLook,
  logoLook,
  sanitizeHtml,
  textLook,
  type Align,
  type Block,
  type ButtonAlign,
  type ButtonBlock,
  type Device,
  type EmailDoc,
  type Section,
} from "@/lib/design";
import { readableInk } from "@/lib/design/slide-design";
import { useBuilder } from "./context";
import { InlineText } from "./InlineText";
import { FOCUS_LINK, caretToEnd, undoKey } from "./shared";

const marginFor = (align: ButtonAlign) =>
  align === "center" ? "0 auto" : align === "right" ? "0 0 0 auto" : "0";

function Empty({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      className="flex min-h-[96px] flex-col items-center justify-center gap-1.5 rounded border border-dashed border-neutral-400 bg-neutral-100/70 p-4 text-center text-xs text-neutral-600"
      style={{ fontFamily: FONTS.arial.stack }}
    >
      {icon}
      {children}
    </div>
  );
}

/**
 * The words on a button, typed straight onto it. Only plain words are kept: whatever is in the
 * box is read as text, never as HTML, and a line break is not allowed.
 */
function ButtonLabel({ block, style }: { block: ButtonBlock; style: React.CSSProperties }) {
  const { dispatch, select, undo, redo } = useBuilder();
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || shown.current === block.label) return;
    el.textContent = block.label;
    shown.current = block.label;
    if (document.activeElement === el) caretToEnd(el);
  }, [block.label]);
  const commit = () => {
    const el = ref.current;
    if (!el) return;
    const label = (el.textContent ?? "").replace(/\s+/g, " ").slice(0, 60);
    shown.current = label;
    dispatch({ type: "updateBlock", id: block.id, patch: { label } });
  };
  return (
    <span
      ref={ref}
      data-button-label={block.id}
      role="textbox"
      aria-label="Words on the button"
      data-placeholder="Button"
      contentEditable
      suppressContentEditableWarning
      className="eb-inline cursor-text outline-none"
      style={style}
      onFocus={() => select({ kind: "block", id: block.id })}
      onInput={commit}
      onBlur={() => {
        commit();
        if (ref.current && ref.current.textContent !== shown.current)
          ref.current.textContent = shown.current;
      }}
      onDrop={(e) => e.preventDefault()}
      onPaste={(e) => {
        e.preventDefault();
        document.execCommand(
          "insertText",
          false,
          e.clipboardData.getData("text/plain").replace(/\s+/g, " "),
        );
      }}
      onKeyDown={(e) => {
        const step = undoKey(e);
        if (step) {
          e.preventDefault();
          if (step === "undo") undo();
          else redo();
        } else if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if ((e.metaKey || e.ctrlKey) && ["b", "i", "u"].includes(e.key.toLowerCase())) {
          // Button words are plain; how they look is set for all buttons under Styles.
          e.preventDefault();
        }
      }}
    />
  );
}

/**
 * One block as it looks in the email, drawn for the canvas. It follows the same sizes and
 * colours as the HTML that is exported, so what is built here is what is sent.
 */
export function BlockView({
  block,
  doc,
  section,
  device,
  selected,
}: {
  block: Block;
  doc: EmailDoc;
  section: Section;
  device: Device;
  selected: boolean;
}) {
  const g = doc.globalStyles;
  const ink = section.styles.textColor ?? g.text.p.color;
  switch (block.type) {
    case "heading":
    case "paragraph": {
      const look = textLook(doc, block, section, device);
      return (
        <InlineText
          block={block}
          style={{
            margin: 0,
            marginBottom: look.spacing,
            fontFamily: look.font,
            fontSize: look.size,
            lineHeight: look.lineHeight,
            color: look.color,
            textAlign: look.align,
            fontWeight:
              block.type === "heading" || look.bold ? (look.bold ? "bold" : "normal") : undefined,
            fontStyle: look.italic ? "italic" : undefined,
            textTransform: look.uppercase ? "uppercase" : undefined,
            letterSpacing: look.letterSpacing || undefined,
          }}
        />
      );
    }
    case "image": {
      const look = imageLook(doc, block);
      if (!look.src)
        return (
          <Empty icon={<ImageIcon className="h-5 w-5" />}>
            {block.role === "logo"
              ? "No logo yet. Choose one under Styles, then Logo."
              : "No picture yet. Choose one in the panel on the left."}
          </Empty>
        );
      return (
        <img
          src={look.src}
          alt={block.alt}
          draggable={false}
          style={{
            display: "block",
            width: look.px ? Math.min(look.px, 600) : `${look.percent}%`,
            maxWidth: "100%",
            height: "auto",
            margin: marginFor(look.align),
            border: borderCss(g.image.border) || undefined,
            borderRadius: g.image.radius || undefined,
            boxSizing: "border-box",
          }}
        />
      );
    }
    case "button": {
      const look = buttonLook(doc, block, device);
      const full = look.align === "full";
      const align: Align = full ? "center" : (look.align as Align);
      return (
        <div style={{ textAlign: align }}>
          <span
            style={{
              display: full ? "block" : "inline-block",
              background: look.bg,
              borderRadius: look.radius,
              border: look.border || undefined,
            }}
          >
            <ButtonLabel
              block={block}
              style={{
                display: full ? "block" : "inline-block",
                minWidth: 24,
                padding: `${look.padding.top}px ${look.padding.right}px ${look.padding.bottom}px ${look.padding.left}px`,
                color: look.color,
                fontFamily: look.font,
                fontSize: look.fontSize,
                fontWeight: look.bold ? "bold" : "normal",
                fontStyle: look.italic ? "italic" : undefined,
                textDecoration: look.underline ? "underline" : undefined,
                letterSpacing: look.letterSpacing || undefined,
                lineHeight: 1.2,
                textAlign: "center",
              }}
            />
          </span>
          {!block.url && selected && (
            <div className="mt-1.5">
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent(FOCUS_LINK))}
                className="inline-flex items-center gap-1 rounded-full border border-neutral-300 bg-white px-2 py-0.5 text-[11px] text-neutral-700 shadow-sm hover:border-neutral-500"
                style={{ fontFamily: FONTS.arial.stack }}
              >
                <Link2 className="h-3 w-3" aria-hidden /> Add link
              </button>
            </div>
          )}
          {(!block.url || !block.label) && !selected && (
            <div
              className="mt-1.5 text-[11px] text-neutral-600"
              style={{ fontFamily: FONTS.arial.stack }}
            >
              {block.label
                ? "No link yet, so this button is left out of the email"
                : "No words yet, so this button is left out of the email"}
            </div>
          )}
        </div>
      );
    }
    case "divider":
      return (
        <div
          style={{ borderTop: `${g.divider.thickness}px ${g.divider.style} ${g.divider.color}` }}
        />
      );
    case "spacer":
      // The stripes only show here, to mark space that is otherwise invisible.
      return (
        <div
          aria-label={`Space, ${block.height} pixels`}
          style={{
            height: block.height,
            background:
              block.styles.background ??
              "repeating-linear-gradient(135deg, rgba(0,0,0,0.07) 0 6px, transparent 6px 12px)",
          }}
        />
      );
    case "banner": {
      if (block.image)
        return (
          <img
            src={block.image}
            alt={block.alt}
            draggable={false}
            style={{ display: "block", width: "100%", height: "auto" }}
          />
        );
      const words = bannerWords(block.design);
      const bg = block.design.slides[0].bg;
      return (
        <div
          style={{
            background: bg,
            color: readableInk(bg, false),
            padding: "40px 32px",
            fontFamily: FONTS[g.text.h1.font].stack,
          }}
        >
          <div style={{ fontSize: 30, lineHeight: 1.1 }}>{words.headline || "Banner"}</div>
          <div
            className="mt-3 flex items-center gap-1.5 text-xs"
            style={{ fontFamily: FONTS.arial.stack }}
          >
            The banner picture has not been made yet.
          </div>
        </div>
      );
    }
    case "products":
      return block.items.length === 0 ? (
        <Empty icon={<ShoppingBag className="h-5 w-5" />}>
          No products yet. Add them in the panel on the left.
        </Empty>
      ) : (
        <div className="grid grid-cols-2">
          {block.items.map((p, i) => (
            <div key={`${p.url}${i}`} style={{ padding: "0 8px 16px 8px" }}>
              <img
                src={p.image}
                alt={p.title}
                draggable={false}
                style={{ display: "block", width: "100%", height: "auto", borderRadius: 6 }}
              />
              <p
                style={{
                  margin: "10px 0 2px 0",
                  fontFamily: FONTS[g.text.h3.font].stack,
                  fontSize: 17,
                  lineHeight: 1.3,
                  color: ink,
                }}
              >
                {p.title}
              </p>
              {p.price && (
                <p
                  style={{
                    margin: 0,
                    fontFamily: FONTS.arial.stack,
                    fontSize: 14,
                    fontWeight: "bold",
                    color: linkLook(doc, section).color,
                  }}
                >
                  {p.price}
                </p>
              )}
            </div>
          ))}
        </div>
      );
    case "code": {
      // Only ever what sanitizeHtml gives back is put on the page, whatever the document holds.
      const html = sanitizeHtml(block.html).html;
      if (!html)
        return (
          <Empty icon={<Code2 className="h-5 w-5" />}>
            No HTML yet. Paste it in the panel on the left.
          </Empty>
        );
      return (
        <div
          data-code-block
          // Kept inside its own box, so nothing in it can lie over the rest of the builder; and its links are not followed here.
          style={{
            position: "relative",
            overflow: "hidden",
            isolation: "isolate",
            contain: "paint",
            fontFamily: FONTS[g.text.p.font].stack,
            fontSize: 16,
            color: ink,
          }}
          onClickCapture={(e) => {
            if ((e.target as HTMLElement).closest("a")) e.preventDefault();
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    case "logo": {
      const look = logoLook(doc, block, device);
      if (!look.src)
        return (
          <Empty icon={<BadgeCheck className="h-5 w-5" />}>
            No logo yet. Choose one in the panel on the left.
          </Empty>
        );
      return (
        <img
          src={look.src}
          alt={block.alt}
          draggable={false}
          style={{
            display: "block",
            width: look.width,
            maxWidth: "100%",
            height: "auto",
            margin: marginFor(look.align),
          }}
        />
      );
    }
    case "social": {
      const links = block.links.filter((l) => l.url);
      if (links.length === 0)
        return (
          <Empty icon={<Share2 className="h-5 w-5" />}>
            No accounts yet. Add their addresses in the panel on the left.
          </Empty>
        );
      const color = block.styles.color ?? linkLook(doc, section).color;
      const align = block.styles.align ?? "center";
      const font = {
        fontFamily: FONTS[g.text.p.font].stack,
        fontSize: block.styles.size ?? 14,
        lineHeight: 1.6,
        color,
      };
      if (block.look === "links") {
        return (
          <p style={{ margin: 0, textAlign: align, ...font }}>
            {links.map((l, i) => (
              <span key={l.network}>
                {i > 0 && " \u00a0\u00b7\u00a0 "}
                <span style={{ textDecoration: "underline" }}>{SOCIAL_NETWORKS[l.network]}</span>
              </span>
            ))}
          </p>
        );
      }
      return (
        <div style={{ textAlign: align }}>
          {links.map((l) => (
            <span
              key={l.network}
              style={{
                display: "inline-block",
                margin: 4,
                padding: "5px 14px",
                border: `1px solid ${color}`,
                borderRadius: 999,
                whiteSpace: "nowrap",
                ...font,
              }}
            >
              {SOCIAL_NETWORKS[l.network]}
            </span>
          ))}
        </div>
      );
    }
    case "video": {
      if (!block.thumbnail || !block.url)
        return (
          <Empty icon={<PlayCircle className="h-5 w-5" />}>
            {block.url
              ? "No picture yet. Choose a still picture in the panel on the left."
              : "No video yet. Paste its address in the panel on the left."}
          </Empty>
        );
      return (
        <div>
          <div
            style={{
              aspectRatio: "16 / 9",
              backgroundColor: "#000000",
              backgroundImage: `url("${block.thumbnail}")`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            role="img"
            aria-label={block.alt || "Video"}
          >
            <span
              style={{
                width: 72,
                height: 72,
                lineHeight: "72px",
                borderRadius: 36,
                background: "rgba(0,0,0,0.65)",
                color: "#ffffff",
                fontFamily: FONTS.arial.stack,
                fontSize: 30,
                textAlign: "center",
              }}
              aria-hidden
            >
              {"\u25b6"}
            </span>
          </div>
          <div
            style={{
              paddingTop: 8,
              textAlign: "center",
              fontFamily: FONTS[g.text.p.font].stack,
              fontSize: 14,
              lineHeight: 1.5,
              color: linkLook(doc, section).color,
              textDecoration: "underline",
            }}
          >
            {block.alt || "Watch the video"}
          </div>
        </div>
      );
    }
    default: {
      const color = block.styles.color ?? "#6b7775";
      return (
        <div
          style={{
            borderTop: `1px solid ${g.divider.color}`,
            paddingTop: 18,
            fontFamily: FONTS.arial.stack,
            fontSize: block.styles.size ?? 12,
            lineHeight: 1.6,
            color,
            textAlign: block.styles.align ?? "center",
          }}
        >
          <span style={{ color: ink, fontWeight: "bold" }}>{block.siteLabel}</span>
          <br />
          {block.why && (
            <>
              {block.why}
              <br />
            </>
          )}
          <span style={{ textDecoration: "underline" }}>Unsubscribe</span>
        </div>
      );
    }
  }
}
