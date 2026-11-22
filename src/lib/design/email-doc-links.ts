// Every link in an email, listed with the block it belongs to, so each can be checked and the
// owner taken straight to the one that needs fixing.
//
// Pure: no network, no DOM and no Deno APIs.

import { UNSUBSCRIBE_PLACEHOLDER } from "./email";
import {
  BLOCK_LABELS,
  SOCIAL_NETWORKS,
  imageLook,
  inlineText,
  logoLook,
  type Block,
  type BlockType,
  type EmailDoc,
} from "./email-doc";
import { sanitizeHtml } from "./html-sanitize";

export interface DocLink {
  blockId: string;
  blockType: BlockType;
  sectionName: string;
  /** What the link is, in a few words: "Button: Shop the sale", "Link in text: our guide". */
  label: string;
  /** The address as it stands in the document, which may be empty or not yet a real address. */
  url: string;
}

const short = (s: string, max = 50) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** The links written into a piece of HTML, with the words each is on. */
function anchors(html: string): { url: string; words: string }[] {
  const out: { url: string; words: string }[] = [];
  const pattern = /<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  for (let m = pattern.exec(html); m; m = pattern.exec(html))
    out.push({
      url: decode(m[1]),
      words: inlineText(m[2].replace(/<img\b[^>]*>/g, " picture "))
        .replace(/\s+/g, " ")
        .trim(),
    });
  return out;
}

function linksOf(doc: EmailDoc, block: Block): { label: string; url: string }[] {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return anchors(block.html).map((a) => ({
        label: `Link in text: ${short(a.words) || "(no words)"}`,
        url: a.url,
      }));
    // A button always counts, since one with no link is left out of the email.
    case "button":
      return [{ label: `Button: ${short(block.label) || "(no words)"}`, url: block.url }];
    case "image": {
      const look = imageLook(doc, block);
      return look.src && look.link
        ? [
            {
              label:
                block.role === "logo"
                  ? "Logo"
                  : `Picture: ${short(block.alt) || "(not described)"}`,
              url: look.link,
            },
          ]
        : [];
    }
    case "banner":
      return block.link ? [{ label: "Banner", url: block.link }] : [];
    case "products":
      return block.items.map((p) => ({ label: `Product: ${short(p.title)}`, url: p.url }));
    case "footer":
      return [
        { label: `Website: ${short(block.siteLabel)}`, url: block.site },
        {
          label: "Unsubscribe",
          url: doc.platform === "shopify" ? "{{ unsubscribe_link }}" : UNSUBSCRIBE_PLACEHOLDER,
        },
      ];
    case "social":
      return block.links.map((l) => ({
        label: `Social: ${SOCIAL_NETWORKS[l.network]}`,
        url: l.url,
      }));
    case "video":
      return [{ label: `Video: ${short(block.alt) || "(not described)"}`, url: block.url }];
    case "logo": {
      const look = logoLook(doc, block);
      return look.src && look.link ? [{ label: "Logo", url: look.link }] : [];
    }
    // What is listed is what would be sent: the pasted HTML after cleaning.
    case "code":
      return anchors(sanitizeHtml(block.html).html).map((a) => ({
        label: `Link in code: ${short(a.words) || "(no words)"}`,
        url: a.url,
      }));
    default:
      return [];
  }
}

/** Every link in the email, in the order the reader meets them. */
export function docLinks(doc: EmailDoc): DocLink[] {
  const out: DocLink[] = [];
  for (const section of doc.sections) {
    for (const row of section.rows) {
      for (const column of row.columns) {
        for (const block of column.blocks) {
          for (const link of linksOf(doc, block))
            out.push({
              blockId: block.id,
              blockType: block.type,
              sectionName: section.name,
              ...link,
            });
        }
      }
    }
  }
  return out;
}

export const linkKind = (link: DocLink) => BLOCK_LABELS[link.blockType];
