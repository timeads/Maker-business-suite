"use client";

/* eslint-disable @next/next/no-img-element -- pictures in an email sit on other hosts, at addresses not known ahead of time */

import { useState } from "react";
import { ImageIcon, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "./ui";
import { alignOf, safeHref, safeUrl, sanitizeHtml, type Block, type CodeBlock } from "@/lib/design";
import { useBuilder } from "./context";
import { PhotoPicker } from "./PhotoPicker";
import { LogoContent, SocialContent, VideoContent } from "./MoreBlockContent";
import { AlignField, Field, NumberField, Segmented, TextField } from "./fields";

const Note = ({ children }: { children: React.ReactNode }) => (
  <p className="text-muted-foreground text-xs leading-relaxed">{children}</p>
);
const linkHint = (value: string) =>
  value && !safeHref(value)
    ? "Links must start with https:// (or mailto: for an email address)."
    : undefined;

/**
 * HTML pasted in by the owner. The box keeps what was typed while it is being typed, but the
 * email only ever takes the cleaned version of it, and the canvas only ever shows that.
 */
function CodeContent({ block }: { block: CodeBlock }) {
  const { dispatch } = useBuilder();
  const [draft, setDraft] = useState(block.html);
  const removed = sanitizeHtml(draft).removed;
  return (
    <div className="space-y-3">
      <Field label="HTML" hint="Paste HTML made for email: tables, text, links and pictures.">
        <Textarea
          className="min-h-[220px] font-mono text-xs"
          spellCheck={false}
          value={draft}
          placeholder={
            '<table role="presentation" width="100%">\n  <tr><td>Hello</td></tr>\n</table>'
          }
          onChange={(e) => {
            setDraft(e.target.value);
            dispatch({ type: "updateBlock", id: block.id, patch: { html: e.target.value } });
          }}
          // Once the box is left it shows what was kept, so what is seen here is what is sent.
          onBlur={() => setDraft(sanitizeHtml(draft).html)}
        />
      </Field>
      {removed.length > 0 && (
        <p
          className="border-note-border bg-note text-foreground rounded-md border p-2 text-xs leading-relaxed"
          role="status"
          data-code-removed
        >
          Taken out, because email programs block it or it is not safe:{" "}
          {removed.slice(0, 6).join(", ")}
          {removed.length > 6 ? ", and more" : ""}.
        </p>
      )}
      <Note>
        Most email programs only support basic HTML, so scripts, forms, style sheets and anything
        interactive are not kept.
      </Note>
    </div>
  );
}

/** What a block holds: its picture, words, link and so on. How it looks is under Styles. */
export function BlockContent({ block }: { block: Block }) {
  const { doc, dispatch } = useBuilder();
  // Whether the photo library is open.
  const [picking, setPicking] = useState(false);
  const patch = (change: Record<string, unknown>) =>
    dispatch({ type: "updateBlock", id: block.id, patch: change });

  switch (block.type) {
    case "heading":
      return (
        <div className="space-y-4">
          <Segmented
            label="Size of heading"
            value={block.level}
            onChange={(level) => patch({ level })}
            options={[
              { value: 1, label: "H1" },
              { value: 2, label: "H2" },
              { value: 3, label: "H3" },
            ]}
          />
          <Note>
            Click the heading on the email to change its words. Select words to make them bold,
            italic, underlined or a link.
          </Note>
        </div>
      );
    case "paragraph":
      return (
        <Note>
          Click the text on the email to change it. Select words to make them bold, italic,
          underlined or a link. Press Enter for a new line.
        </Note>
      );
    case "image":
      if (block.role === "logo") {
        return (
          <div className="space-y-4">
            {doc.globalStyles.logo.src && (
              <img
                src={doc.globalStyles.logo.src}
                alt=""
                className="border-border max-h-24 w-full rounded border object-contain"
              />
            )}
            <Note>
              This is the email&apos;s logo. To change the picture, its width, its place or its
              link, go to Styles on the left, then Logo.
            </Note>
            <TextField
              label="What the picture shows"
              value={block.alt}
              onChange={(alt) => patch({ alt })}
              hint="Read out to people who cannot see the picture."
            />
          </div>
        );
      }
      return (
        <div className="space-y-4">
          {block.src && (
            <img
              src={block.src}
              alt=""
              className="border-border max-h-40 w-full rounded border object-contain"
            />
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => setPicking(true)}>
            <ImageIcon /> {block.src ? "Change picture" : "Choose from library"}
          </Button>
          <TextField
            label="What the picture shows"
            value={block.alt}
            onChange={(alt) => patch({ alt })}
            placeholder="A tufted rug in blue and yellow"
            hint="Read out to people who cannot see the picture."
          />
          <TextField
            label="Link when clicked (optional)"
            value={block.link}
            onChange={(link) => patch({ link })}
            placeholder="https://example.com"
            inputMode="url"
            hint={linkHint(block.link)}
          />
          <NumberField
            label="Width"
            value={block.width}
            min={10}
            max={100}
            unit="%"
            onChange={(width) => patch({ width })}
          />
          <AlignField
            value={alignOf(doc, block)}
            onChange={(align) =>
              dispatch({ type: "updateBlockStyles", id: block.id, patch: { align } })
            }
          />
          <PhotoPicker
            open={picking}
            onOpenChange={setPicking}
            onSelect={(picked) => {
              const url = safeUrl(picked);
              if (url) patch({ src: url });
              setPicking(false);
            }}
          />
        </div>
      );
    case "button":
      return (
        <div className="space-y-4">
          <TextField
            label="Words on the button"
            value={block.label}
            onChange={(label) => patch({ label })}
            placeholder="Shop the sale"
          />
          <div data-link-field>
            <TextField
              label="Where it goes"
              value={block.url}
              onChange={(url) => patch({ url })}
              placeholder="https://example.com"
              inputMode="url"
              hint={
                linkHint(block.url) ??
                (block.url ? undefined : "A button with no link is left out of the email.")
              }
            />
          </div>
          <Note>You can also change the words by clicking the button on the email.</Note>
        </div>
      );
    case "divider":
      return (
        <Note>
          A thin line with space around it. Its colour, thickness and style are set for the whole
          email, under Styles on the left, then Divider.
        </Note>
      );
    case "spacer":
      return (
        <div className="space-y-4">
          <NumberField
            label="Height"
            value={block.height}
            min={4}
            max={200}
            onChange={(height) => patch({ height })}
          />
          <Note>Empty space. The stripes only show here, not in the email.</Note>
        </div>
      );
    case "banner":
      return (
        <div className="space-y-4">
          {block.image && (
            <img src={block.image} alt="" className="border-border w-full rounded border" />
          )}
          <Note>The banner is a picture made with your brand&apos;s own fonts and colours.</Note>
          <TextField
            label="What the banner says"
            value={block.alt}
            onChange={(alt) => patch({ alt })}
            hint="Read out to people who cannot see the picture."
          />
          <TextField
            label="Link when clicked"
            value={block.link}
            onChange={(link) => patch({ link })}
            placeholder="https://example.com"
            inputMode="url"
            hint={linkHint(block.link)}
          />
        </div>
      );
    case "products":
      return (
        <div className="space-y-3">
          {block.items.map((p, k) => (
            <div key={`${p.url}${k}`} className="flex items-center gap-2 text-sm">
              <img
                src={p.image}
                alt=""
                className="border-border h-10 w-10 shrink-0 rounded border object-cover"
              />
              <span className="min-w-0 flex-1 truncate">
                {p.title} <span className="text-muted-foreground">{p.price}</span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-8 px-0"
                aria-label={`Remove ${p.title}`}
                title="Remove"
                onClick={() => patch({ items: block.items.filter((_, n) => n !== k) })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Note>Products sit two to a row. Each links to its page in the shop.</Note>
        </div>
      );
    case "code":
      return <CodeContent key={block.id} block={block} />;
    case "social":
      return <SocialContent block={block} />;
    case "video":
      return <VideoContent block={block} />;
    case "logo":
      return <LogoContent block={block} />;
    default:
      return (
        <div className="space-y-4">
          <TextField
            label="Website name shown"
            value={block.siteLabel}
            onChange={(siteLabel) => patch({ siteLabel })}
          />
          <TextField
            label="Website address"
            value={block.site}
            onChange={(site) => patch({ site })}
            placeholder="https://example.com"
            inputMode="url"
            hint={
              block.site && !safeUrl(block.site)
                ? "The address must start with https://"
                : undefined
            }
          />
          <Field label="Why they got this email">
            <Textarea
              className="min-h-[72px]"
              value={block.why}
              onChange={(e) => patch({ why: e.target.value })}
            />
          </Field>
          <Note>
            {doc.platform === "shopify"
              ? "The Unsubscribe link is added for you. Shopify fills it in when it sends."
              : "The Unsubscribe link is marked in the HTML. Replace the marker with your email platform's own unsubscribe tag before sending."}
          </Note>
        </div>
      );
  }
}
