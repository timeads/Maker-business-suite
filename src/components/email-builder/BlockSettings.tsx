"use client";

import { useEffect, useState } from "react";
import { Copy, RotateCcw } from "lucide-react";
import { toast } from "./ui";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui";
import {
  NO_SPACE,
  alignOf,
  buttonLook,
  findBlock,
  isStyled,
  renderBlockHtml,
  spacingOf,
  textLook,
  type Block,
  type BlockStyles,
  type Box,
  type Device,
} from "@/lib/design";
import { useBuilder } from "./context";
import { BlockContent } from "./BlockContent";
import { AlignField, ColorField, DeviceCard, NumberField, PaddingField } from "./fields";
import { FOCUS_LINK, copyText } from "./shared";

const HAS_ALIGN: Block["type"][] = [
  "heading",
  "paragraph",
  "image",
  "button",
  "footer",
  "social",
  "logo",
];
const HAS_TEXT: Block["type"][] = ["heading", "paragraph", "button", "footer"];
// A Social block's words can be recoloured here; their size is with its content, as it is the same on every device.
const HAS_COLOR: Block["type"][] = [...HAS_TEXT, "social"];

/** How one block looks where it differs from the rest of the email. */
function BlockStylesTab({ block, columns }: { block: Block; columns: number }) {
  const { doc, dispatch } = useBuilder();
  const s = block.styles;
  const set = (patch: Partial<BlockStyles>) =>
    dispatch({ type: "updateBlockStyles", id: block.id, patch });
  const textSize = (device: Device) =>
    block.type === "heading" || block.type === "paragraph"
      ? textLook(doc, block, null, device).size
      : block.type === "button"
        ? buttonLook(doc, block, device).fontSize
        : (s.size ?? 12);
  // Spacing and text size are kept per device: the computer's on the styles themselves, the phone's under `mobile`.
  const setBox = (device: Device, key: "padding" | "margin", box: Box) =>
    set(
      device === "desktop"
        ? { desktop: { ...s.desktop, [key]: box } }
        : { mobile: { ...s.mobile, [key]: box } },
    );
  const setSize = (device: Device, size: number) =>
    set(device === "desktop" ? { size } : { mobile: { ...s.mobile, size } });
  return (
    <div className="space-y-5">
      <ColorField
        label="Background colour"
        brand={doc.brand}
        value={s.background}
        onChange={(background) => set({ background })}
        onClear={() => set({ background: undefined })}
      />
      {HAS_ALIGN.includes(block.type) && (
        <AlignField value={alignOf(doc, block)} onChange={(align) => set({ align })} />
      )}
      {HAS_COLOR.includes(block.type) && (
        <ColorField
          label="Text colour"
          brand={doc.brand}
          value={s.color}
          onChange={(color) => set({ color })}
          onClear={() => set({ color: undefined })}
        />
      )}
      {block.type !== "spacer" && (
        <DeviceCard same={s.sameForMobile} onSame={(sameForMobile) => set({ sameForMobile })}>
          {(device) => {
            const space = spacingOf(doc, block, columns, device);
            return (
              <>
                {HAS_TEXT.includes(block.type) && (
                  <NumberField
                    label="Text size"
                    value={textSize(device)}
                    min={10}
                    max={72}
                    onChange={(size) => setSize(device, size)}
                  />
                )}
                <PaddingField
                  label="Space inside"
                  value={space.padding}
                  onChange={(box) => setBox(device, "padding", box)}
                />
                <PaddingField
                  label="Space outside"
                  value={space.margin ?? NO_SPACE}
                  onChange={(box) => setBox(device, "margin", box)}
                />
              </>
            );
          }}
        </DeviceCard>
      )}
    </div>
  );
}

/** The HTML this one block becomes in the exported email. To look at and copy, not to change. */
function BlockCodeTab({ id }: { id: string }) {
  const { doc } = useBuilder();
  const { html, phoneCss } = renderBlockHtml(doc, id);
  const copy = async () => {
    if (await copyText(html)) toast.success("This block's HTML is copied.");
    else
      toast.error("Copying is blocked in this browser. Select the HTML below and copy it by hand.");
  };
  if (!html)
    return (
      <p className="text-muted-foreground text-xs leading-relaxed">
        This block is left out of the email as it stands, so it has no HTML yet. A button needs
        words and a link; a picture needs choosing; text needs words.
      </p>
    );
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="bg-sunken rounded px-1.5 py-0.5 font-mono text-[10px] uppercase">
          html
        </span>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy
        </Button>
      </div>
      <textarea
        readOnly
        aria-label="This block's HTML"
        data-block-code
        className="bg-sunken/40 h-64 w-full resize-y rounded-md border p-2 font-mono text-[11px] leading-relaxed"
        value={html}
        spellCheck={false}
      />
      {phoneCss && (
        <>
          <p className="text-xs font-medium">On phones, these rules also apply</p>
          <textarea
            readOnly
            aria-label="This block's rules for phones"
            className="bg-sunken/40 h-20 w-full resize-y rounded-md border p-2 font-mono text-[11px] leading-relaxed"
            value={phoneCss}
            spellCheck={false}
          />
        </>
      )}
      <p className="text-muted-foreground text-[11px] leading-relaxed">
        This is the part of the exported email this block makes. It is for looking at and copying:
        change the block with Content and Styles.
      </p>
    </div>
  );
}

/** The side panel for a selected block: what it holds, how it looks, and the HTML it becomes. */
export function BlockSettings({ id }: { id: string }) {
  const { doc, dispatch } = useBuilder();
  const [tab, setTab] = useState("content");
  // The "Add link" pill on a button asks for its link box, which is on the Content tab.
  useEffect(() => {
    const show = () => {
      setTab("content");
      requestAnimationFrame(() =>
        document.querySelector<HTMLInputElement>("[data-link-field] input")?.focus(),
      );
    };
    window.addEventListener(FOCUS_LINK, show);
    return () => window.removeEventListener(FOCUS_LINK, show);
  }, []);
  const found = findBlock(doc, id);
  if (!found) return null;
  const { block } = found;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-4 mt-3 grid h-9 grid-cols-3">
          <TabsTrigger value="content" className="text-xs">
            Content
          </TabsTrigger>
          <TabsTrigger value="styles" className="text-xs">
            Styles
          </TabsTrigger>
          <TabsTrigger value="code" className="text-xs">
            Code
          </TabsTrigger>
        </TabsList>
        <TabsContent value="content" className="min-h-0 flex-1 overflow-y-auto p-4">
          <BlockContent key={block.id} block={block} />
        </TabsContent>
        <TabsContent value="styles" className="min-h-0 flex-1 overflow-y-auto p-4">
          <BlockStylesTab key={block.id} block={block} columns={found.row.columns.length} />
        </TabsContent>
        <TabsContent value="code" className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === "code" && <BlockCodeTab id={block.id} />}
        </TabsContent>
      </Tabs>
      <div className="border-t p-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={!isStyled(block.styles)}
          onClick={() => dispatch({ type: "clearBlockStyles", id })}
          title="Go back to the email's own styles for this block"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Clear styles
        </Button>
      </div>
    </div>
  );
}
