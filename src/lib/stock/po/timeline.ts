/**
 * Everything that has happened to a purchase order, on one line of time:
 * started, sent, emailed to whom, each delivery and what the shop said,
 * tracking added, renamed, closed. Pure. Each fact is read from the table
 * that already holds it; nothing is copied into a second place to draw this.
 * After TuftStock's `buildTimeline` (components/po/PoDetail.tsx), with who
 * did each thing, since the suite has a team.
 */

export type TimelineTone = "plain" | "good" | "bad";

export type TimelineItem = {
  at: string;
  title: string;
  detail: string | null;
  /** A member's id, for their name. Null when nobody did it, or we don't know who. */
  by: string | null;
  tone: TimelineTone;
};

export type TimelineInput = {
  createdAt: string;
  createdBy: string | null;
  /** From a spreadsheet: the order was brought in, not started here. */
  imported: boolean;
  /** When it went out, for orders sent before the log began (or imported). */
  orderedAt: string | null;
  closedAt: string | null;
  status: string;
  events: { kind: string; detail: string; actor: string | null; at: string }[];
  emails: {
    status: string;
    to: string[];
    subject: string;
    from: string;
    by: string | null;
    at: string;
    error: string | null;
  }[];
  receipts: {
    quantity: number;
    name: string;
    by: string | null;
    at: string;
    imported: boolean;
    shopStatus: string;
    shopAt: string | null;
    shopError: string | null;
  }[];
  shipments: {
    carrier: string;
    tracking: string;
    by: string | null;
    at: string;
    removedAt: string | null;
  }[];
};

const EVENT_TITLES: Record<string, string> = {
  sent: "Marked as sent to the supplier",
  back_to_draft: "Put back to draft",
  closed: "Closed",
  cancelled: "Cancelled",
  renamed: "Renamed",
  archived: "Put away (archived)",
  unarchived: "Brought back from the archive",
};

const units = (n: number) => `${n} unit${n === 1 ? "" : "s"}`;
/** Deliveries checked in with one press share a time to the second and a person. */
const pressKey = (receipt: { at: string; by: string | null }) =>
  `${receipt.at.slice(0, 19)}|${receipt.by ?? ""}`;

export function buildTimeline(input: TimelineInput): TimelineItem[] {
  const items: TimelineItem[] = [
    {
      at: input.createdAt,
      title: input.imported ? "Brought in from a spreadsheet" : "Order started",
      detail: null,
      by: input.createdBy,
      tone: "plain",
    },
  ];
  const logged = new Set(input.events.map((event) => event.kind));
  // Orders from before the log, and imported ones, still say when they went out and closed.
  if (input.orderedAt && !logged.has("sent")) {
    items.push({
      at: input.orderedAt,
      title: EVENT_TITLES.sent,
      detail: null,
      by: null,
      tone: "plain",
    });
  }
  if (input.closedAt && !logged.has("closed") && !logged.has("cancelled")) {
    items.push({
      at: input.closedAt,
      title: input.status === "cancelled" ? EVENT_TITLES.cancelled : EVENT_TITLES.closed,
      detail: null,
      by: null,
      tone: "plain",
    });
  }
  for (const event of input.events) {
    items.push({
      at: event.at,
      title:
        event.kind === "closed" && !event.actor
          ? "Closed: everything has arrived"
          : (EVENT_TITLES[event.kind] ?? event.kind),
      detail: event.detail || null,
      by: event.actor,
      tone: event.kind === "cancelled" ? "bad" : "plain",
    });
  }
  for (const email of input.emails) {
    const to = email.to.join(", ");
    items.push({
      at: email.at,
      title:
        email.status === "sent"
          ? `Emailed to ${to}`
          : email.status === "failed"
            ? `An email to ${to} didn't send`
            : email.status === "unsure"
              ? `An email to ${to} may or may not have gone`
              : `Emailing ${to}`,
      detail:
        [`“${email.subject}”`, `from ${email.from}`, email.status !== "sent" ? email.error : null]
          .filter(Boolean)
          .join(" · ") || null,
      by: email.by,
      tone: email.status === "sent" ? "plain" : email.status === "failed" ? "bad" : "plain",
    });
  }
  // One entry per press of "check in", not one per line.
  const presses = new Map<string, TimelineInput["receipts"]>();
  for (const receipt of input.receipts) {
    const key = pressKey(receipt);
    presses.set(key, [...(presses.get(key) ?? []), receipt]);
  }
  for (const group of presses.values()) {
    const first = group[0];
    const total = group.reduce((n, receipt) => n + receipt.quantity, 0);
    const what = group.map((receipt) => `${receipt.quantity} × ${receipt.name}`).join(", ");
    items.push({
      at: first.at,
      title: first.imported
        ? `${units(total)} had arrived (from a spreadsheet)`
        : `Checked in ${units(total)}`,
      detail: what,
      by: first.by,
      tone: "good",
    });
    const added = group.filter((receipt) => receipt.shopStatus === "sent");
    if (added.length > 0) {
      items.push({
        at: added
          .map((receipt) => receipt.shopAt ?? receipt.at)
          .sort()
          .at(-1)!,
        title: `Added ${units(added.reduce((n, r) => n + r.quantity, 0))} to your shop's count`,
        detail: added.map((receipt) => `${receipt.quantity} × ${receipt.name}`).join(", "),
        by: null,
        tone: "good",
      });
    }
    const failed = group.filter((receipt) => receipt.shopStatus === "failed");
    if (failed.length > 0) {
      items.push({
        at: failed
          .map((receipt) => receipt.shopAt ?? receipt.at)
          .sort()
          .at(-1)!,
        title: `Your shop didn't take ${units(failed.reduce((n, r) => n + r.quantity, 0))}`,
        detail:
          [
            failed.map((receipt) => `${receipt.quantity} × ${receipt.name}`).join(", "),
            failed.find((receipt) => receipt.shopError)?.shopError,
          ]
            .filter(Boolean)
            .join(" · ") || null,
        by: null,
        tone: "bad",
      });
    }
  }
  for (const shipment of input.shipments) {
    const name = `${shipment.carrier || "Tracking"} ${shipment.tracking}`.trim();
    items.push({
      at: shipment.at,
      title: `Tracking added: ${name}`,
      detail: null,
      by: shipment.by,
      tone: "plain",
    });
    if (shipment.removedAt) {
      items.push({
        at: shipment.removedAt,
        title: `Tracking taken off: ${name}`,
        detail: null,
        by: null,
        tone: "plain",
      });
    }
  }
  // Oldest first; things that share a moment keep the order they were added in.
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) => new Date(a.item.at).getTime() - new Date(b.item.at).getTime() || a.index - b.index,
    )
    .map(({ item }) => item);
}
