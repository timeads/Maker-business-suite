import { formatMoney } from "@/lib/dashboard/format";
import { addressLines } from "@/lib/shipping/carriers";
import { code128 } from "@/lib/shipping/code128";
import type { ShippingSettings, SlipLayout, SlipSection } from "@/lib/shipping/config";
import type { ShippingOrder } from "./data";

const SIZES: Record<SlipLayout["text_size"], string> = {
  small: "12px",
  normal: "14px",
  large: "16px",
};
const label = "text-[0.72em] font-semibold tracking-[0.14em] uppercase";

/** The order number as bars, for Scan & pack to read back. Nothing if it can't be encoded. */
export function OrderBarcode({ text, height = 44 }: { text: string; height?: number }) {
  const code = code128(text);
  if (!code) return null;
  return (
    <svg
      role="img"
      aria-label={`Barcode for order ${text}`}
      viewBox={`0 0 ${code.width} ${height}`}
      width={code.width * 1.6}
      height={height}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      className="max-w-full"
    >
      <rect width={code.width} height={height} fill="#fff" />
      {code.bars.map((bar) => (
        <rect key={bar.x} x={bar.x} y={0} width={bar.width} height={height} fill="#000" />
      ))}
    </svg>
  );
}

/** One packing slip: who it's from, who it's for, and what goes in the box. */
export function PackingSlip({
  order,
  settings,
  layout,
  workspaceName,
  timeZone,
  currency,
}: {
  order: ShippingOrder;
  settings: ShippingSettings;
  layout: SlipLayout;
  workspaceName: string;
  timeZone: string;
  currency: string;
}) {
  const from = settings.ship_from;
  const fromLines = [from.address1, from.address2, from.city_line, from.country].filter(Boolean);
  const items = order.items.filter((item) => item.left > 0);
  const placed = new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "long" }).format(
    new Date(order.placed_at),
  );
  const code = (order.name ?? "").replace(/^#/, "").trim();
  const to = addressLines(order, settings.ship_from_country);
  const priced = layout.show_price && items.some((item) => item.price != null);

  const parts: Record<SlipSection, () => React.ReactNode> = {
    shipto: () => (
      <section key="shipto" className="min-w-0 flex-[1.4]">
        <p className={label}>{order.pickup ? "Pickup for" : "Send to"}</p>
        {(order.pickup ? to.slice(0, 2) : to).map((line, index) => (
          <p key={index} className="font-read text-[1.15em] leading-snug">
            {line}
          </p>
        ))}
        {to.length === 0 && <p className="font-read">No address on this order</p>}
        {order.phone && <p className="font-read text-[0.85em]">{order.phone}</p>}
      </section>
    ),
    method: () =>
      order.shipping_method ? (
        <section key="method" className="min-w-0 flex-1">
          <p className={label}>{order.pickup ? "Collecting" : "Shipping"}</p>
          <p className="font-read">{order.shipping_method}</p>
        </section>
      ) : null,
    items: () => (
      <table key="items" className="w-full text-left">
        <thead>
          <tr className="border-b border-black/40">
            <th className={`w-10 py-1.5 ${label}`} aria-label="Packed" />
            <th className={`w-14 py-1.5 ${label}`}>Qty</th>
            <th className={`py-1.5 ${label}`}>Item</th>
            {layout.show_sku && <th className={`py-1.5 text-right ${label}`}>Code</th>}
            {priced && <th className={`py-1.5 text-right ${label}`}>Price</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.line_id} className="break-inside-avoid border-b border-black/15">
              <td className="py-2">
                <span aria-hidden className="block size-4 rounded-[3px] border-2 border-black/60" />
              </td>
              <td className="py-2 text-[1.15em] font-bold tabular-nums">{item.left}</td>
              <td className="font-read py-2">
                {item.title}
                {item.variant && <span className="block text-[0.85em]">{item.variant}</span>}
                {item.left < item.qty && (
                  <span className="block text-[0.85em]">
                    {item.qty - item.left} of {item.qty} already sent
                  </span>
                )}
              </td>
              {layout.show_sku && (
                <td className="py-2 text-right font-mono text-[0.85em]">{item.sku ?? ""}</td>
              )}
              {priced && (
                <td className="py-2 text-right tabular-nums">
                  {item.price == null
                    ? ""
                    : // Whole cents times a count, so nothing drifts.
                      formatMoney((Math.round(item.price * 100) * item.left) / 100, currency)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    ),
    note: () =>
      order.note ? (
        <section key="note">
          <p className={label}>Note from the customer</p>
          <p className="font-read whitespace-pre-wrap">{order.note}</p>
        </section>
      ) : null,
    message: () =>
      layout.message ? (
        <p key="message" className="font-read text-center whitespace-pre-wrap">
          {layout.message}
        </p>
      ) : null,
    barcode: () =>
      code ? (
        <div key="barcode" className="flex flex-col items-center gap-1">
          <OrderBarcode text={code} />
          <p className="text-[0.85em] tabular-nums">{code}</p>
        </div>
      ) : null,
  };

  const shown = layout.sections.filter((section) => section.on).map((section) => section.id);
  const body: React.ReactNode[] = [];
  for (let i = 0; i < shown.length; i++) {
    const id = shown[i];
    const next = shown[i + 1];
    // The address and the shipping method sit side by side when they're neighbours.
    if ((id === "shipto" && next === "method") || (id === "method" && next === "shipto")) {
      body.push(
        <div key={`${id}-${next}`} className="flex gap-6">
          {parts[id]()}
          {parts[next]()}
        </div>,
      );
      i++;
    } else {
      body.push(parts[id]());
    }
  }

  return (
    <article
      style={{ fontSize: SIZES[layout.text_size] }}
      className="border-border flex break-after-page flex-col gap-6 rounded-lg border bg-white p-6 text-black last:break-after-auto print:rounded-none print:border-0 print:p-0"
    >
      <header className="flex items-start justify-between gap-6 border-b-2 border-black pb-3">
        <div>
          <p className="text-[1.3em] font-bold">{from.name || workspaceName}</p>
          {fromLines.map((line) => (
            <p key={line} className="font-read text-[0.85em]">
              {line}
            </p>
          ))}
        </div>
        <div className="text-right">
          <p className="text-[1.3em] font-bold tabular-nums">{order.name ?? "Order"}</p>
          <p className="text-[0.85em]">{placed}</p>
        </div>
      </header>
      {body}
      {layout.footer && (
        <footer className="font-read border-t border-black/30 pt-3 text-center text-[0.85em]">
          {layout.footer}
        </footer>
      )}
    </article>
  );
}
