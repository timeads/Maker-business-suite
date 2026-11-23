import { formatMoney } from "../../dashboard/format";
import { addressLines, type ShipTo } from "../carriers";
import { code128 } from "../code128";
import { shipFromCityLine, type ShippingSettings, type SlipLayout } from "../config";
import { wrapText, zplText } from "./zpl";

/**
 * A packing slip for the Zebra: the same words, in the same order, as the
 * slip on screen (`slip.tsx`), written in the printer's own text and barcode
 * commands at 4 × 6 inches. Nothing is drawn as a picture, so it prints
 * quickly and sharply, and a long order runs onto more labels between lines.
 */

export type SlipOrder = ShipTo & {
  name: string | null;
  placed_at: string;
  phone: string | null;
  shipping_method: string | null;
  pickup: boolean;
  note: string | null;
  items: {
    line_id: string;
    title: string;
    variant: string | null;
    sku: string | null;
    price?: number | null;
    qty: number;
    left: number;
  }[];
};

export type SlipPart =
  | { kind: "shipto"; heading: string; lines: string[]; phone: string }
  | { kind: "method"; heading: string; text: string }
  | {
      kind: "items";
      showSku: boolean;
      priced: boolean;
      rows: { qty: number; title: string; details: string[]; sku: string; price: string }[];
    }
  | { kind: "note"; heading: string; text: string }
  | { kind: "message"; text: string }
  | { kind: "barcode"; code: string };

/** Everything a slip says, as plain words: what both the screen and the printer show. */
export type SlipData = {
  fromName: string;
  fromLines: string[];
  orderName: string;
  placed: string;
  textSize: SlipLayout["text_size"];
  parts: SlipPart[];
  footer: string;
};

export function buildSlipData(input: {
  order: SlipOrder;
  settings: ShippingSettings;
  layout: SlipLayout;
  workspaceName: string;
  timeZone: string;
  currency: string;
  /** What the barcode says, when it isn't the order's own number (orders sent together). */
  code?: string;
  /** For orders sent together: which order each line came from, by line id. */
  from?: ReadonlyMap<string, string>;
}): SlipData {
  const { order, settings, layout } = input;
  const from = settings.ship_from;
  const items = order.items.filter((item) => item.left > 0);
  const to = addressLines(order, settings.ship_from_country);
  const priced = layout.show_price && items.some((item) => item.price != null);
  const code = (input.code ?? order.name ?? "").replace(/^#/, "").trim();
  const parts: SlipPart[] = [];
  for (const section of layout.sections) {
    if (!section.on) continue;
    if (section.id === "shipto") {
      parts.push({
        kind: "shipto",
        heading: order.pickup ? "Pickup for" : "Send to",
        lines: to.length === 0 ? ["No address on this order"] : order.pickup ? to.slice(0, 2) : to,
        phone: order.phone ?? "",
      });
    } else if (section.id === "method") {
      if (order.shipping_method) {
        parts.push({
          kind: "method",
          heading: order.pickup ? "Collecting" : "Shipping",
          text: order.shipping_method,
        });
      }
    } else if (section.id === "items") {
      parts.push({
        kind: "items",
        showSku: layout.show_sku,
        priced,
        rows: items.map((item) => ({
          qty: item.left,
          title: item.title,
          details: [
            ...(item.variant ? [item.variant] : []),
            ...(input.from?.has(item.line_id) ? [`Order ${input.from.get(item.line_id)}`] : []),
            ...(item.left < item.qty
              ? [`${item.qty - item.left} of ${item.qty} already sent`]
              : []),
          ],
          sku: item.sku ?? "",
          price:
            item.price == null
              ? ""
              : // Whole cents times a count, so nothing drifts.
                formatMoney((Math.round(item.price * 100) * item.left) / 100, input.currency),
        })),
      });
    } else if (section.id === "note") {
      if (order.note)
        parts.push({ kind: "note", heading: "Note from the customer", text: order.note });
    } else if (section.id === "message") {
      if (layout.message) parts.push({ kind: "message", text: layout.message });
    } else if (section.id === "barcode") {
      if (code) parts.push({ kind: "barcode", code });
    }
  }
  return {
    fromName: from.name || input.workspaceName,
    fromLines: [from.address1, from.address2, shipFromCityLine(from), from.country].filter(Boolean),
    orderName: order.name ?? "Order",
    placed: new Intl.DateTimeFormat("en-US", {
      timeZone: input.timeZone,
      dateStyle: "long",
    }).format(new Date(order.placed_at)),
    textSize: layout.text_size,
    parts,
    footer: layout.footer ?? "",
  };
}

/** Dots tall at 203 dpi, for each text size a slip can be set to. */
const BASE: Record<SlipLayout["text_size"], number> = { small: 22, normal: 26, large: 30 };

/** A barcode ZPL can print as it stands: plain characters, none that ^BC reads as commands. */
const barcodeSafe = (code: string) =>
  /^[\x20-\x7e]{1,32}$/.test(code) && !/[\^~>]/.test(code) && code128(code) !== null;

/** One slip as ZPL: one 4 × 6 label, or several when the order is long. */
export function slipZpl(slip: SlipData, dpi: number = 203): string {
  const k = dpi / 203;
  const dots = (n: number) => Math.round(n * k);
  const W = Math.round(4 * dpi);
  const H = Math.round(6 * dpi);
  const M = dots(32);
  const inner = W - 2 * M;
  const base = dots(BASE[slip.textSize] ?? BASE.normal);
  const small = Math.round(base * 0.82);
  const big = Math.round(base * 1.3);
  const lineOf = (size: number) => Math.round(size * 1.22);
  // The printer's own font runs a little over half as wide as it is tall.
  const fits = (width: number, size: number) => Math.max(4, Math.floor(width / (size * 0.56)));

  const pages: string[][] = [[]];
  let y = M;
  const put = (field: string) => pages[pages.length - 1].push(field);
  /** Starts another label when `height` won't fit on this one. */
  const room = (height: number) => {
    if (y + height > H - M && y > M) {
      pages.push([]);
      y = M;
    }
  };
  const field = (
    x: number,
    size: number,
    value: string,
    block?: { width: number; align: "L" | "C" | "R" },
  ) =>
    put(
      `^FO${x},${y}^A0N,${size},${size}${block ? `^FB${block.width},1,0,${block.align}` : ""}^FH^FD${zplText(value)}^FS`,
    );
  const lines = (
    value: string,
    size: number,
    x = M,
    width = inner,
    align: "L" | "C" | "R" = "L",
  ) => {
    for (const line of wrapText(value, fits(width, size))) {
      room(lineOf(size));
      field(x, size, line, align === "L" ? undefined : { width, align });
      y += lineOf(size);
    }
  };
  const rule = (thick: number) => {
    room(thick + dots(10));
    put(`^FO${M},${y}^GB${inner},${thick},${thick}^FS`);
    y += thick + dots(10);
  };
  const gap = (n: number) => {
    y += dots(n);
  };
  const heading = (value: string) => {
    // Kept with the line under it.
    room(lineOf(small) + lineOf(base));
    lines(value.toUpperCase(), Math.round(base * 0.7));
  };

  // Who it is from on the left, which order on the right.
  const top = y;
  const left = Math.round(inner * 0.58);
  lines(slip.fromName, big, M, left);
  for (const line of slip.fromLines) lines(line, small, M, left);
  const afterLeft = y;
  y = top;
  const right = inner - left - dots(12);
  lines(slip.orderName, big, M + left + dots(12), right, "R");
  lines(slip.placed, small, M + left + dots(12), right, "R");
  y = Math.max(y, afterLeft) + dots(6);
  rule(dots(3));

  for (const part of slip.parts) {
    gap(8);
    if (part.kind === "shipto") {
      heading(part.heading);
      for (const line of part.lines) lines(line, Math.round(base * 1.15));
      if (part.phone) lines(part.phone, small);
    } else if (part.kind === "method") {
      heading(part.heading);
      lines(part.text, base);
    } else if (part.kind === "note") {
      heading(part.heading);
      lines(part.text, base);
    } else if (part.kind === "message") {
      lines(part.text, base, M, inner, "C");
    } else if (part.kind === "items") {
      const tick = dots(22);
      const qtyX = M + tick + dots(14);
      const titleX = qtyX + dots(64);
      const priceW = part.priced ? dots(120) : 0;
      const skuW = part.showSku ? dots(170) : 0;
      const titleW = inner - (titleX - M) - priceW - skuW - dots(8);
      const head = Math.round(base * 0.7);
      room(lineOf(head) + dots(12) + lineOf(base) * 2);
      field(qtyX, head, "QTY");
      field(titleX, head, "ITEM");
      if (part.showSku) field(titleX + titleW, head, "CODE", { width: skuW, align: "R" });
      if (part.priced) field(M + inner - priceW, head, "PRICE", { width: priceW, align: "R" });
      y += lineOf(head);
      rule(dots(2));
      for (const row of part.rows) {
        const titleLines = wrapText(row.title, fits(titleW, base));
        const detailLines = row.details.flatMap((detail) => wrapText(detail, fits(titleW, small)));
        const height =
          Math.max(lineOf(big), titleLines.length * lineOf(base)) +
          detailLines.length * lineOf(small);
        // A line stays whole: it moves to the next label rather than being cut in two.
        room(height + dots(12));
        const rowTop = y;
        put(`^FO${M},${y + dots(2)}^GB${tick},${tick},${dots(2)}^FS`);
        field(qtyX, big, String(row.qty));
        if (part.showSku && row.sku) {
          const skuLines = wrapText(row.sku, fits(skuW, small)).slice(0, 2);
          for (const [index, line] of skuLines.entries()) {
            y = rowTop + index * lineOf(small);
            field(titleX + titleW, small, line, { width: skuW, align: "R" });
          }
          y = rowTop;
        }
        if (part.priced && row.price) {
          field(M + inner - priceW, base, row.price, { width: priceW, align: "R" });
        }
        for (const line of titleLines) {
          field(titleX, base, line);
          y += lineOf(base);
        }
        for (const line of detailLines) {
          field(titleX, small, line);
          y += lineOf(small);
        }
        y = Math.max(y, rowTop + lineOf(big)) + dots(4);
        rule(1);
      }
    } else if (part.kind === "barcode") {
      const tall = dots(90);
      const bar = [dots(2), Math.max(1, dots(2) - 1), 1].find(
        (width) => ((part.code.length + 2) * 11 + 13) * width <= inner,
      );
      if (bar && barcodeSafe(part.code)) {
        const wide = ((part.code.length + 2) * 11 + 13) * bar;
        room(tall + lineOf(small) + dots(8));
        put(
          `^FO${M + Math.floor((inner - wide) / 2)},${y}^BY${bar},3,${tall}^BCN,${tall},N,N,N^FD${part.code}^FS`,
        );
        y += tall + dots(8);
      }
      lines(part.code, small, M, inner, "C");
    }
  }

  if (slip.footer) {
    gap(8);
    rule(1);
    lines(slip.footer, small, M, inner, "C");
  }

  return pages
    .filter((page) => page.length > 0)
    .map((page) => `^XA^CI28^PW${W}^LL${H}^LH0,0${page.join("")}^XZ`)
    .join("\n");
}
