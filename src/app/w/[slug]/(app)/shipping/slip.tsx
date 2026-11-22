import { addressLines } from "@/lib/shipping/carriers";
import type { ShippingSettings } from "@/lib/shipping/config";
import type { ShippingOrder } from "./data";

/** One packing slip: who it's from, who it's for, and what goes in the box. */
export function PackingSlip({
  order,
  settings,
  workspaceName,
  timeZone,
}: {
  order: ShippingOrder;
  settings: ShippingSettings;
  workspaceName: string;
  timeZone: string;
}) {
  const from = settings.ship_from;
  const fromLines = [from.address1, from.address2, from.city_line, from.country].filter(Boolean);
  const items = order.items.filter((item) => item.left > 0);
  const placed = new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "long" }).format(
    new Date(order.placed_at),
  );
  return (
    <article className="bg-card border-border flex break-after-page flex-col gap-6 rounded-lg border p-6 text-sm text-black last:break-after-auto print:rounded-none print:border-0 print:p-0">
      <header className="flex items-start justify-between gap-6">
        <div>
          <p className="text-lg font-bold">{from.name || workspaceName}</p>
          {fromLines.map((line) => (
            <p key={line} className="font-read text-xs">
              {line}
            </p>
          ))}
        </div>
        <div className="text-right">
          <p className="text-lg font-bold tabular-nums">{order.name ?? "Order"}</p>
          <p className="text-xs">{placed}</p>
          {order.shipping_method && <p className="text-xs">{order.shipping_method}</p>}
        </div>
      </header>

      <section>
        <p className="text-[10px] font-semibold tracking-[0.14em] uppercase">Send to</p>
        {addressLines(order).map((line, index) => (
          <p key={index} className="font-read text-base leading-snug">
            {line}
          </p>
        ))}
        {order.phone && <p className="font-read text-xs">{order.phone}</p>}
      </section>

      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-black/40 text-[10px] tracking-[0.14em] uppercase">
            <th className="w-10 py-1.5 font-semibold" aria-label="Packed" />
            <th className="w-14 py-1.5 font-semibold">Qty</th>
            <th className="py-1.5 font-semibold">Item</th>
            {settings.slip_show_sku && <th className="py-1.5 text-right font-semibold">Code</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.line_id} className="border-b border-black/15">
              <td className="py-2">
                <span aria-hidden className="block size-4 rounded-[3px] border-2 border-black/60" />
              </td>
              <td className="py-2 text-base font-bold tabular-nums">{item.left}</td>
              <td className="font-read py-2">
                {item.title}
                {item.variant && <span className="block text-xs">{item.variant}</span>}
                {item.left < item.qty && (
                  <span className="block text-xs">
                    {item.qty - item.left} of {item.qty} already sent
                  </span>
                )}
              </td>
              {settings.slip_show_sku && (
                <td className="py-2 text-right font-mono text-xs">{item.sku ?? ""}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {order.note && (
        <section>
          <p className="text-[10px] font-semibold tracking-[0.14em] uppercase">
            Note from the customer
          </p>
          <p className="font-read whitespace-pre-wrap">{order.note}</p>
        </section>
      )}
      {settings.slip_note && (
        <p className="font-read border-t border-black/20 pt-4 text-center whitespace-pre-wrap">
          {settings.slip_note}
        </p>
      )}
    </article>
  );
}
