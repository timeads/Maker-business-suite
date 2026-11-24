import { code128 } from "@/lib/shipping/code128";
import type { SlipData, SlipPart } from "@/lib/shipping/zebra/slip";

/**
 * One packing slip, drawn. This is the only place a slip is laid out: the
 * slips page and the settings preview show it, a browser prints it on paper,
 * and a Zebra prints this very sheet as a picture (`slip-draw.ts`), so the
 * three can't drift apart. It uses only the classes in `SLIP_CSS` and plain
 * elements, with no hooks, so it renders the same on the server and in the
 * browser.
 */

/** Screen pixels per bar module: three printer dots at 203 dpi, which is what the Zebra lays down. */
const MODULE_PX = (3 * 96) / 203;

/** The slip's code as bars. A Zebra's bars are laid down again at whole dots, where this box sits. */
export function SlipBars({ text }: { text: string }) {
  const code = code128(text);
  if (!code) return null;
  return (
    <div className="bars" data-slip-code={text}>
      <svg
        role="img"
        aria-label={`Barcode ${text}`}
        viewBox={`0 0 ${code.width} 10`}
        width={Math.round(code.width * MODULE_PX)}
        preserveAspectRatio="none"
        shapeRendering="crispEdges"
      >
        <rect width={code.width} height={10} fill="#fff" />
        {code.bars.map((bar) => (
          <rect key={bar.x} x={bar.x} y={0} width={bar.width} height={10} fill="#000" />
        ))}
      </svg>
    </div>
  );
}

const lines = (values: string[]) =>
  values.map((value, index) => (
    <span key={index}>
      {index > 0 && <br />}
      {value}
    </span>
  ));

function Part({ part }: { part: SlipPart }) {
  if (part.kind === "shipto") {
    return (
      <div className="sec">
        <div className="lbl">{part.heading}</div>
        {/* Who and where, as on the label. The phone number stays off the sheet. */}
        <div>{lines(part.lines)}</div>
      </div>
    );
  }
  if (part.kind === "method") {
    return (
      <div className="sec">
        {part.text && (
          <>
            <div className="lbl">{part.heading}</div>
            <div>{part.text}</div>
          </>
        )}
        {part.more.map((extra, index) => (
          <div key={extra.heading}>
            <div className={part.text || index > 0 ? "lbl more" : "lbl"}>{extra.heading}</div>
            <div>{extra.text}</div>
          </div>
        ))}
      </div>
    );
  }
  if (part.kind === "items") {
    return (
      <table>
        <thead>
          <tr>
            <th className="q">Qty</th>
            {part.showPhoto && <th className="img" />}
            <th>Item</th>
            {part.priced && <th className="p">Price</th>}
          </tr>
        </thead>
        <tbody>
          {part.rows.map((row, index) => {
            const codes = [
              part.showSku && row.sku ? `SKU ${row.sku}` : "",
              part.showBarcode && row.barcode ? `Barcode ${row.barcode}` : "",
            ].filter(Boolean);
            const under = [...row.details, ...(codes.length > 0 ? [codes.join(" · ")] : [])];
            return (
              <tr key={index}>
                <td className="q">{row.qty}</td>
                {part.showPhoto && (
                  <td className="img">
                    {row.image && (
                      // eslint-disable-next-line @next/next/no-img-element -- the shop's own picture of the item, on the shop's image servers
                      <img src={row.image} alt="" />
                    )}
                  </td>
                )}
                <td>
                  <b className="it">{row.title}</b>
                  {under.length > 0 && <div className="v">{lines(under)}</div>}
                </td>
                {part.priced && <td className="p">{row.price}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }
  if (part.kind === "note") {
    return (
      <div className="note">
        <b>Note:</b> {part.text}
      </div>
    );
  }
  if (part.kind === "message") return <div className="msg">{part.text}</div>;
  return (
    <div className="code">
      <SlipBars text={part.code} />
      <div className="v">{part.caption}</div>
    </div>
  );
}

export function SlipSheet({
  slip,
  logo = null,
  size = "4x6",
}: {
  slip: SlipData;
  /** The workspace's logo as a `data:` picture, from our own storage; null when it has none. */
  logo?: string | null;
  size?: "4x6" | "letter";
}) {
  const header = slip.header ?? {
    logo: false,
    logoSize: "medium" as const,
    align: "left" as const,
    name: "always" as const,
    address: "",
  };
  const drawn = header.logo && logo ? logo : null;
  const named = header.name === "always" || (header.name === "without_logo" && !drawn);
  const body: React.ReactNode[] = [];
  for (let i = 0; i < slip.parts.length; i++) {
    const part = slip.parts[i];
    const next = slip.parts[i + 1];
    // The address and the shipping method sit side by side when they're neighbours.
    if (
      next &&
      ((part.kind === "shipto" && next.kind === "method") ||
        (part.kind === "method" && next.kind === "shipto"))
    ) {
      body.push(
        <div key={i} className="cols">
          <Part part={part} />
          <Part part={next} />
        </div>,
      );
      i++;
    } else {
      body.push(<Part key={i} part={part} />);
    }
    // Anything after the items sits at the bottom of the label.
    if (part.kind === "items") body.push(<div key={`push-${i}`} className="push" />);
  }
  return (
    <section className={`slip ${size === "letter" ? "letter" : "s4x6"} f-${slip.textSize}`}>
      <div className={`head ${header.align}`}>
        <div className="brandbox">
          {drawn && (
            // eslint-disable-next-line @next/next/no-img-element -- the workspace's own logo, already read from our storage
            <img className={`logo ${header.logoSize}`} src={drawn} alt="" />
          )}
          {named && slip.fromName && <div className="brand">{slip.fromName}</div>}
          {header.address && <div className="v">{header.address}</div>}
        </div>
        <div className="right">
          <div className="order">{slip.orderName}</div>
          {slip.boxLabel && <div className="boxno">{slip.boxLabel}</div>}
          <div className="v">{slip.placed}</div>
        </div>
      </div>
      {body}
      {slip.footer && <div className="foot">{slip.footer}</div>}
    </section>
  );
}
