import { describe, expect, it } from "vitest";
import { buildTimeline, type TimelineInput } from "./timeline";

const base: TimelineInput = {
  createdAt: "2026-11-01T10:00:00Z",
  createdBy: "u1",
  imported: false,
  orderedAt: null,
  closedAt: null,
  status: "draft",
  events: [],
  emails: [],
  receipts: [],
  shipments: [],
};

describe("an order's timeline", () => {
  it("starts with the order being started, and who started it", () => {
    expect(buildTimeline(base)).toEqual([
      { at: base.createdAt, title: "Order started", detail: null, by: "u1", tone: "plain" },
    ]);
  });

  it("puts everything in the order it happened", () => {
    const titles = buildTimeline({
      ...base,
      status: "closed",
      orderedAt: "2026-11-02T09:00:00Z",
      closedAt: "2026-11-20T15:00:05Z",
      events: [
        {
          kind: "renamed",
          detail: "HI-202611-AAAAAA → Spring yarn",
          actor: "u1",
          at: "2026-11-01T11:00:00Z",
        },
        { kind: "sent", detail: "", actor: "u2", at: "2026-11-02T09:00:00Z" },
        { kind: "closed", detail: "", actor: null, at: "2026-11-20T15:00:05Z" },
      ],
      emails: [
        {
          status: "sent",
          to: ["orders@mill.test"],
          subject: "Order Spring yarn",
          from: "me@shop.test",
          by: "u2",
          at: "2026-11-02T09:00:01Z",
          error: null,
        },
        {
          status: "failed",
          to: ["orders@mill.test"],
          subject: "Order Spring yarn",
          from: "me@shop.test",
          by: "u2",
          at: "2026-11-02T08:59:00Z",
          error: "Gmail said no",
        },
      ],
      shipments: [
        {
          carrier: "UPS",
          tracking: "1Z999AA10123456784",
          by: "u1",
          at: "2026-11-05T12:00:00Z",
          removedAt: null,
        },
      ],
      receipts: [
        {
          quantity: 6,
          name: "Wool rug",
          by: "u3",
          at: "2026-11-20T15:00:00.123Z",
          imported: false,
          shopStatus: "sent",
          shopAt: "2026-11-20T15:00:03Z",
          shopError: null,
        },
        {
          quantity: 4,
          name: "Yarn",
          by: "u3",
          at: "2026-11-20T15:00:00.456Z",
          imported: false,
          shopStatus: "failed",
          shopAt: "2026-11-20T15:00:04Z",
          shopError: "The shop said no",
        },
      ],
    }).map((item) => `${item.title}${item.by ? ` [${item.by}]` : ""}`);
    expect(titles).toEqual([
      "Order started [u1]",
      "Renamed [u1]",
      "An email to orders@mill.test didn't send [u2]",
      "Marked as sent to the supplier [u2]",
      "Emailed to orders@mill.test [u2]",
      "Tracking added: UPS 1Z999AA10123456784 [u1]",
      "Checked in 10 units [u3]",
      "Added 6 units to your shop's count",
      "Your shop didn't take 4 units",
      "Closed: everything has arrived",
    ]);
  });

  it("says a failed shop update in red, with the reason", () => {
    const item = buildTimeline({
      ...base,
      receipts: [
        {
          quantity: 1,
          name: "Yarn",
          by: null,
          at: "2026-11-20T15:00:00Z",
          imported: false,
          shopStatus: "failed",
          shopAt: null,
          shopError: "The shop said no",
        },
      ],
    }).at(-1)!;
    expect(item).toMatchObject({
      tone: "bad",
      title: "Your shop didn't take 1 unit",
      detail: "1 × Yarn · The shop said no",
    });
  });

  it("still tells an older or imported order's story from its own dates", () => {
    const titles = buildTimeline({
      ...base,
      imported: true,
      createdAt: "2026-01-01T00:00:00Z",
      status: "cancelled",
      orderedAt: "2026-01-02T00:00:00Z",
      closedAt: "2026-01-09T00:00:00Z",
      receipts: [
        {
          quantity: 3,
          name: "Yarn",
          by: null,
          at: "2026-01-05T00:00:00Z",
          imported: true,
          shopStatus: "skipped",
          shopAt: null,
          shopError: null,
        },
      ],
    }).map((item) => item.title);
    expect(titles).toEqual([
      "Brought in from a spreadsheet",
      "Marked as sent to the supplier",
      "3 units had arrived (from a spreadsheet)",
      "Cancelled",
    ]);
  });

  it("notes a tracking number that was taken off again", () => {
    const titles = buildTimeline({
      ...base,
      shipments: [
        {
          carrier: "",
          tracking: "ABC1234",
          by: null,
          at: "2026-11-05T12:00:00Z",
          removedAt: "2026-11-06T12:00:00Z",
        },
      ],
    }).map((item) => item.title);
    expect(titles.slice(1)).toEqual([
      "Tracking added: Tracking ABC1234",
      "Tracking taken off: Tracking ABC1234",
    ]);
  });
});
