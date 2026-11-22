// An email document as the HTML that is pasted into the sending platform. Email programs are
// far behind web browsers, so the layout is tables with every style written on the element.
// The one style sheet holds only the rules for phones (columns stack, and whatever has been
// given a different size or spacing on a phone), which cannot be written any other way.
//
// Pure: no network, no DOM and no Deno APIs.

import { UNSUBSCRIBE_PLACEHOLDER } from "./email";
import {
  CONTENT_WIDTH,
  FONTS,
  SOCIAL_NETWORKS,
  UNSUBSCRIBE_TAG,
  bannerWords,
  borderCss,
  buttonLook,
  columnWidths,
  escapeHtml as esc,
  imageLook,
  linkLook,
  logoLook,
  sectionWidth,
  spacingOf,
  textLook,
  unsubscribeHref,
  type Align,
  type Block,
  type Box,
  type ButtonAlign,
  type EmailDoc,
  type Section,
  type TextLook,
} from "./email-doc";
import { normalizeDoc } from "./email-doc-read";
import { sanitizeHtml } from "./html-sanitize";
import { readableInk } from "./slide-design";

const TABLE = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"';
/** Class of a column that stacks on a phone. */
const STACK = "eb-col";
const SMALL_PRINT = "#6b7775";

/** Size of the HTML as an email program counts it. */
export const htmlBytes = (html: string) => new TextEncoder().encode(html).length;

/**
 * The rules for phones, gathered while the email is written out. Each different set of rules
 * gets one class name, shared by every element that needs exactly those rules.
 */
class PhoneRules {
  private rules = new Map<string, string>();
  /** The class for these declarations, or "" when there are none. Each must end in !important, to beat the styles written on the element. */
  name(declarations: string): string {
    if (!declarations) return "";
    let name = this.rules.get(declarations);
    if (!name) {
      name = `eb-m${this.rules.size + 1}`;
      this.rules.set(declarations, name);
    }
    return name;
  }
  attr(declarations: string, also = ""): string {
    const names = [also, this.name(declarations)].filter(Boolean).join(" ");
    return names ? ` class="${names}"` : "";
  }
  /** The rules as CSS: all of them, or only those for the class names that appear in a piece of HTML. */
  css(usedIn?: string): string {
    return [...this.rules]
      .filter(
        ([, name]) => usedIn === undefined || new RegExp(`class="[^"]*\\b${name}\\b`).test(usedIn),
      )
      .map(([declarations, name]) => `.${name}{${declarations}}`)
      .join("");
  }
}

const px = (b: Box) => `${b.top}px ${b.right}px ${b.bottom}px ${b.left}px`;
const sameBox = (a: Box, b: Box) =>
  a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
const marginFor = (align: ButtonAlign) =>
  align === "center" ? "margin:0 auto;" : align === "right" ? "margin:0 0 0 auto;" : "margin:0;";
const tdAlign = (align: ButtonAlign): Align => (align === "full" ? "center" : align);

function textCss(look: TextLook, heading: boolean): string {
  return (
    `margin:${look.spacing ? `0 0 ${look.spacing}px 0` : "0"};font-family:${look.font};font-size:${look.size}px;line-height:${look.lineHeight};` +
    (heading || look.bold ? `font-weight:${look.bold ? "bold" : "normal"};` : "") +
    (look.italic ? "font-style:italic;" : "") +
    (look.uppercase ? "text-transform:uppercase;" : "") +
    (look.letterSpacing ? `letter-spacing:${look.letterSpacing}px;` : "") +
    `color:${look.color};text-align:${look.align};`
  );
}

interface Ctx {
  doc: EmailDoc;
  phone: PhoneRules;
  section: Section;
  /** When one block's HTML is wanted on its own, its id, and where what it made is put. */
  want?: { id: string; html: string };
}

function blockHtml(ctx: Ctx, block: Block, columns: number, width: number): string {
  const html = blockRow(ctx, block, columns, width);
  if (ctx.want?.id === block.id) ctx.want.html = html;
  return html;
}

function blockRow(ctx: Ctx, block: Block, columns: number, width: number): string {
  const { doc, phone, section } = ctx;
  const g = doc.globalStyles;
  const desk = spacingOf(doc, block, columns, "desktop");
  const mob = spacingOf(doc, block, columns, "mobile");
  const inner = Math.max(
    40,
    width - desk.padding.left - desk.padding.right - desk.margin.left - desk.margin.right,
  );
  let align: Align = "center";
  let body = "";
  switch (block.type) {
    case "heading":
    case "paragraph": {
      if (!block.html) return "";
      const look = textLook(doc, block, section, "desktop");
      const small = textLook(doc, block, section, "mobile");
      const link = linkLook(doc, section);
      const linkCss = `color:${link.color};text-decoration:${link.underline ? "underline" : "none"};${link.bold ? "font-weight:bold;" : ""}`;
      const tag = block.type === "heading" ? `h${block.level}` : "p";
      const onPhone =
        (small.size !== look.size ? `font-size:${small.size}px!important;` : "") +
        (small.lineHeight !== look.lineHeight ? `line-height:${small.lineHeight}!important;` : "") +
        (small.spacing !== look.spacing ? `margin-bottom:${small.spacing}px!important;` : "");
      align = look.align;
      // Links inside formatted text take the email's link style. The text is already safe.
      body = `<${tag}${phone.attr(onPhone)} style="${textCss(look, block.type === "heading")}">${block.html.replace(
        /<a href="([^"]*)">/g,
        (_all, href: string) =>
          // An unsubscribe link in the text is written the way the platform the email is now for expects, whichever it was put in as.
          `<a href="${href === UNSUBSCRIBE_TAG || href === UNSUBSCRIBE_PLACEHOLDER ? unsubscribeHref(doc.platform) : href}" style="${linkCss}">`,
      )}</${tag}>`;
      break;
    }
    case "image": {
      const look = imageLook(doc, block);
      if (!look.src) return "";
      align = look.align;
      const w = Math.min(inner, look.px ?? Math.round((inner * look.percent) / 100));
      const border = borderCss(g.image.border);
      const img =
        `<img src="${esc(look.src)}" alt="${esc(block.alt)}" width="${w}" style="display:block;width:100%;max-width:${w}px;height:auto;border:${border || "0"};` +
        `${g.image.radius ? `border-radius:${g.image.radius}px;` : ""}${marginFor(align)}">`;
      body = look.link ? `<a href="${esc(look.link)}">${img}</a>` : img;
      break;
    }
    case "button": {
      if (!block.label || !block.url) return "";
      const look = buttonLook(doc, block, "desktop");
      const small = buttonLook(doc, block, "mobile");
      align = tdAlign(look.align);
      const full = look.align === "full";
      const tableOnPhone =
        small.align === look.align
          ? ""
          : small.align === "full"
            ? "width:100%!important;"
            : `width:auto!important;float:none!important;${marginFor(small.align).replace(";", "!important;")}`;
      const linkOnPhone =
        (small.align !== look.align
          ? `display:${small.align === "full" ? "block" : "inline-block"}!important;`
          : "") +
        (sameBox(small.padding, look.padding) ? "" : `padding:${px(small.padding)}!important;`) +
        (small.fontSize !== look.fontSize ? `font-size:${small.fontSize}px!important;` : "");
      const border = look.border ? `border:${look.border};` : "";
      body =
        `<table${phone.attr(tableOnPhone)} role="presentation" cellpadding="0" cellspacing="0" border="0"${full ? ' width="100%"' : ` align="${look.align}"`} style="${full ? "" : marginFor(look.align)}"><tr>` +
        `<td align="center" bgcolor="${look.bg}" style="background:${look.bg};border-radius:${look.radius}px;${border}">` +
        `<a${phone.attr(linkOnPhone)} href="${esc(block.url)}" style="display:${full ? "block" : "inline-block"};padding:${px(look.padding)};font-family:${look.font};font-size:${look.fontSize}px;line-height:1.2;` +
        `font-weight:${look.bold ? "bold" : "normal"};${look.italic ? "font-style:italic;" : ""}${look.letterSpacing ? `letter-spacing:${look.letterSpacing}px;` : ""}color:${look.color};` +
        `text-decoration:${look.underline ? "underline" : "none"};text-align:center;border-radius:${look.radius}px;">${esc(block.label)}</a></td></tr></table>`;
      break;
    }
    case "logo": {
      const look = logoLook(doc, block, "desktop");
      if (!look.src) return "";
      align = look.align;
      const w = Math.min(inner, look.width);
      const small = Math.min(logoLook(doc, block, "mobile").width, w);
      const img = `<img${phone.attr(small !== w ? `max-width:${small}px!important;` : "")} src="${esc(look.src)}" alt="${esc(block.alt)}" width="${w}" style="display:block;width:100%;max-width:${w}px;height:auto;border:0;${marginFor(align)}">`;
      body = look.link ? `<a href="${esc(look.link)}">${img}</a>` : img;
      break;
    }
    case "social": {
      const links = block.links.filter((l) => l.url);
      if (links.length === 0) return "";
      align = block.styles.align ?? "center";
      const color = block.styles.color ?? linkLook(doc, section).color;
      const font = `font-family:${FONTS[g.text.p.font].stack};font-size:${block.styles.size ?? 14}px;line-height:1.6;`;
      if (block.look === "links") {
        // Names as plain links, with a dot between: nothing here needs a picture to load.
        body =
          `<p style="margin:0;${font}color:${color};text-align:${align};">` +
          links
            .map(
              (l) =>
                `<a href="${esc(l.url)}" style="color:${color};text-decoration:underline;">${SOCIAL_NETWORKS[l.network]}</a>`,
            )
            .join(" &nbsp;&middot;&nbsp; ") +
          "</p>";
      } else {
        // Each name in its own outlined cell. Cells, not styled links, because Outlook ignores padding on a link. Four to a row, so they fit a phone.
        const rows: string[] = [];
        for (let i = 0; i < links.length; i += 4) {
          rows.push(
            `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${align}" style="${marginFor(align)}"><tr>` +
              links
                .slice(i, i + 4)
                .map(
                  (l) =>
                    `<td style="padding:4px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border:1px solid ${color};border-radius:999px;padding:5px 14px;">` +
                    `<a href="${esc(l.url)}" style="${font}color:${color};text-decoration:none;white-space:nowrap;">${SOCIAL_NETWORKS[l.network]}</a></td></tr></table></td>`,
                )
                .join("") +
              "</tr></table>",
          );
        }
        body = rows.join("");
      }
      break;
    }
    case "video": {
      if (!block.url || !block.thumbnail) return "";
      const height = Math.round((inner * 9) / 16);
      const words = block.alt || "Watch the video";
      const thumb = esc(block.thumbnail);
      // Email cannot play video. The still picture is the background of a cell, with a play mark made of
      // text in a round cell on top, and both link to the video. Outlook does not show backgrounds set
      // this way, so it is given the same picture in its own drawing language inside a comment only it reads.
      body =
        `${TABLE}><tr><td${phone.attr("height:190px!important;")} background="${thumb}" bgcolor="#000000" height="${height}" align="center" valign="middle" style="height:${height}px;background-color:#000000;background-image:url('${thumb}');background-size:cover;background-position:center;">` +
        `<!--[if gte mso 9]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:${inner}px;height:${height}px;"><v:fill type="frame" src="${thumb}" color="#000000" /><v:textbox inset="0,0,0,0"><![endif]-->` +
        `<div><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr><td align="center" valign="middle" width="72" height="72" bgcolor="#000000" style="width:72px;height:72px;border-radius:36px;background-color:rgba(0,0,0,0.65);">` +
        `<a href="${esc(block.url)}" title="${esc(words)}" style="display:block;width:72px;line-height:72px;font-family:${FONTS.arial.stack};font-size:30px;color:#ffffff;text-decoration:none;text-align:center;">&#9654;</a></td></tr></table></div>` +
        `<!--[if gte mso 9]></v:textbox></v:rect><![endif]--></td></tr>` +
        // The words under it are the link for anyone whose email program hides pictures.
        `<tr><td align="center" style="padding-top:8px;font-family:${FONTS[g.text.p.font].stack};font-size:14px;line-height:1.5;"><a href="${esc(block.url)}" style="color:${linkLook(doc, section).color};text-decoration:underline;">${esc(words)}</a></td></tr></table>`;
      break;
    }
    case "code": {
      // Pasted HTML is cleaned again here, so what is sent never depends on how the document was stored.
      body = sanitizeHtml(block.html).html;
      if (!body) return "";
      align = "left";
      break;
    }
    case "divider":
      body = `${TABLE}><tr><td style="border-top:${g.divider.thickness}px ${g.divider.style} ${g.divider.color};font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
      break;
    case "spacer":
      return `<tr><td height="${block.height}" style="height:${block.height}px;font-size:0;line-height:0;${block.styles.background ? `background:${block.styles.background};` : ""}">&nbsp;</td></tr>`;
    case "banner": {
      if (block.image) {
        const img = `<img src="${esc(block.image)}" alt="${esc(block.alt)}" width="${inner}" style="display:block;width:100%;max-width:${inner}px;height:auto;border:0;">`;
        body = block.link ? `<a href="${esc(block.link)}">${img}</a>` : img;
      } else {
        // Without its picture the banner's words are set as text, so the email still reads.
        const words = bannerWords(block.design);
        const bg = block.design.slides[0].bg;
        const ink = readableInk(bg, false);
        const h1 = g.text.h1;
        body =
          `${TABLE} style="background:${esc(bg)};"><tr><td style="padding:40px 32px;">` +
          (words.kicker
            ? `<p style="margin:0 0 10px 0;font-family:${FONTS.arial.stack};font-size:13px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${ink};">${esc(words.kicker)}</p>`
            : "") +
          `<h1 style="margin:0;font-family:${FONTS[h1.font].stack};font-size:38px;line-height:1.1;font-weight:${h1.bold ? "bold" : "normal"};color:${ink};">${esc(words.headline)}</h1>` +
          (words.body
            ? `<p style="margin:14px 0 0 0;font-family:${FONTS.arial.stack};font-size:16px;line-height:1.5;color:${ink};">${esc(words.body)}</p>`
            : "") +
          "</td></tr></table>";
      }
      break;
    }
    case "products": {
      if (block.items.length === 0) return "";
      const ink = section.styles.textColor ?? g.text.p.color;
      const photo = Math.max(40, Math.round(inner / 2) - 16);
      const item = (p: (typeof block.items)[number] | undefined) =>
        !p
          ? '<td width="50%" style="padding:0 8px 16px 8px;"></td>'
          : `<td width="50%" valign="top" style="padding:0 8px 16px 8px;"><a href="${esc(p.url)}" style="text-decoration:none;color:${ink};">` +
            `<img src="${esc(p.image)}" alt="${esc(p.title)}" width="${photo}" style="display:block;width:100%;max-width:${photo}px;height:auto;border:0;border-radius:6px;">` +
            `<p style="margin:10px 0 2px 0;font-family:${FONTS[g.text.h3.font].stack};font-size:17px;line-height:1.3;color:${ink};">${esc(p.title)}</p>` +
            (p.price
              ? `<p style="margin:0;font-family:${FONTS.arial.stack};font-size:14px;font-weight:bold;color:${linkLook(doc, section).color};">${esc(p.price)}</p>`
              : "") +
            "</a></td>";
      const rows: string[] = [];
      for (let i = 0; i < block.items.length; i += 2)
        rows.push(`<tr>${item(block.items[i])}${item(block.items[i + 1])}</tr>`);
      body = `${TABLE}>${rows.join("")}</table>`;
      break;
    }
    default: {
      // Shopify fills in its own placeholder when it sends. Any other platform has its own tag
      // for the unsubscribe link, which the owner puts in place of the marker.
      const unsubscribe =
        doc.platform === "shopify" ? "{{ unsubscribe_link }}" : UNSUBSCRIBE_PLACEHOLDER;
      const color = block.styles.color ?? SMALL_PRINT;
      align = block.styles.align ?? "center";
      body =
        `${TABLE}><tr><td align="center" style="border-top:1px solid ${g.divider.color};padding-top:18px;font-family:${FONTS.arial.stack};font-size:${block.styles.size ?? 12}px;line-height:1.6;color:${color};text-align:${align};">` +
        `<a href="${esc(block.site)}" style="color:${section.styles.textColor ?? g.text.p.color};font-weight:bold;text-decoration:none;">${esc(block.siteLabel)}</a><br>` +
        (block.why ? `${esc(block.why)}<br>` : "") +
        `<a href="${unsubscribe}" style="color:${color};text-decoration:underline;">Unsubscribe</a></td></tr></table>`;
    }
  }
  const background = block.styles.background ? `background:${block.styles.background};` : "";
  const padOnPhone = sameBox(desk.padding, mob.padding)
    ? ""
    : `padding:${px(mob.padding)}!important;`;
  const cell = `<td${phone.attr(padOnPhone)} align="${align}" style="padding:${px(desk.padding)};${background}">${body}</td>`;
  // Space outside the block's background needs a cell of its own around it.
  if (
    sameBox(desk.margin, { top: 0, right: 0, bottom: 0, left: 0 }) &&
    sameBox(mob.margin, desk.margin)
  )
    return `<tr>${cell}</tr>`;
  const marginOnPhone = sameBox(desk.margin, mob.margin)
    ? ""
    : `padding:${px(mob.margin)}!important;`;
  return `<tr><td${phone.attr(marginOnPhone)} style="padding:${px(desk.margin)};">${TABLE}><tr>${cell}</tr></table></td></tr>`;
}

function sectionHtml(
  doc: EmailDoc,
  phone: PhoneRules,
  section: Section,
  want?: Ctx["want"],
): string {
  const ctx: Ctx = { doc, phone, section, want };
  const s = section.styles;
  const width = sectionWidth(section);
  const rows = section.rows
    .map((row) => {
      const widths = columnWidths(row.layout, width);
      const cells = row.columns.map((column, i) =>
        column.blocks.map((b) => blockHtml(ctx, b, widths.length, widths[i])).join(""),
      );
      if (cells.every((c) => !c)) return "";
      if (widths.length === 1) return cells[0];
      const stack = row.stackOnMobile ? ` class="${STACK}"` : "";
      const tds = cells.map(
        (cell, i) =>
          `<td${stack} width="${widths[i]}" valign="top" style="width:${widths[i]}px;vertical-align:top;">${cell ? `${TABLE}>${cell}</table>` : ""}</td>`,
      );
      return `<tr><td>${TABLE}><tr>${tds.join("")}</tr></table></td></tr>`;
    })
    .filter(Boolean)
    .join("\n");
  if (!rows) return "";
  const border = borderCss(s.border);
  const boxed = border || s.padding.top || s.padding.right || s.padding.bottom || s.padding.left;
  const inside = boxed
    ? `<tr><td style="padding:${px(s.padding)};${border ? `border:${border};` : ""}">${TABLE}>\n${rows}\n</table></td></tr>`
    : rows;
  const band =
    (s.background ? `background-color:${s.background};` : "") +
    (s.image
      ? `background-image:url('${esc(s.image)}');background-size:cover;background-position:center;`
      : "");
  return `<tr><td align="center"${s.background ? ` bgcolor="${s.background}"` : ""}${s.image ? ` background="${esc(s.image)}"` : ""}${band ? ` style="${band}"` : ""}>
<table role="presentation" width="${CONTENT_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${CONTENT_WIDTH}px;background:${s.contentBg ?? doc.globalStyles.contentBg};">
${inside}
</table>
</td></tr>`;
}

/**
 * One block's part of the exported HTML, for showing its code: the table row it becomes, and
 * the phone rules that apply to it, if any. "" for a block that is left out of the email.
 */
export function renderBlockHtml(
  input: EmailDoc,
  blockId: string,
): { html: string; phoneCss: string } {
  const doc = normalizeDoc(input);
  // The whole email is written out and this block's part picked from it, so the part is exactly what the email holds, class names and all.
  const phone = new PhoneRules();
  const want = { id: blockId, html: "" };
  for (const section of doc.sections) sectionHtml(doc, phone, section, want);
  return { html: want.html, phoneCss: want.html ? phone.css(want.html) : "" };
}

/**
 * The whole email as HTML. `{{ unsubscribe_link }}` and `{{ open_tracking }}` are Shopify's own
 * placeholders: Shopify requires them in a custom-coded email and fills them in when it sends.
 * The document is checked again on the way through, so only safe text and https: addresses
 * can reach the HTML whatever was typed.
 */
export function renderDocHtml(input: EmailDoc, opts: { lang?: string } = {}): string {
  const doc = normalizeDoc(input);
  const g = doc.globalStyles;
  const phone = new PhoneRules();
  const sections = doc.sections
    .map((s) => sectionHtml(doc, phone, s))
    .filter(Boolean)
    .join("\n");
  // A background picture is an extra: many email programs leave it out, and the colour is what shows then.
  const picture = g.pageBgImage
    ? `background-image:url('${esc(g.pageBgImage)}');background-size:cover;background-position:center top;`
    : "";
  return `<!DOCTYPE html>
<html lang="${esc(opts.lang ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.meta.subject || doc.title)}</title>
<style>@media (max-width:600px){.${STACK}{display:block!important;width:100%!important;max-width:100%!important;}${phone.css()}}</style>
</head>
<body style="margin:0;padding:0;background:${g.pageBg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${g.pageBg};">${esc(doc.meta.previewText)}</div>
${TABLE} bgcolor="${g.pageBg}"${g.pageBgImage ? ` background="${esc(g.pageBgImage)}"` : ""} style="background-color:${g.pageBg};${picture}"><tr><td align="center" style="padding:24px 0;">
${TABLE}>
${sections}
</table>
</td></tr></table>
${doc.platform === "shopify" ? "{{ open_tracking }}" : ""}
</body>
</html>`;
}
