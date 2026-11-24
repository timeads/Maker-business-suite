import { describe, expect, it } from "vitest";
import {
  DEFAULT_PO_EMAIL,
  composeDefaults,
  fingerprint,
  firstName,
  parsePoEmail,
  poChanges,
  poEmailSchema,
  poSnapshot,
  readSnapshot,
  sendLabel,
  type PoForEmail,
} from "./email";

const line = (id: string, title: string, sku: string, qty: number, unitCost = "3.50") => ({
  stockItemId: `v-${id}`,
  title,
  sku,
  supplierSku: null,
  qtyOrdered: qty,
  unitCost,
});
const po = (over: Partial<PoForEmail> = {}): PoForEmail => ({
  reference: "HI-202611-ABC123",
  supplierName: "Hill Mill Yarns",
  contactName: "Sam and Pat",
  lines: [line("1", "Tufting frame", "FRAME", 10, "120.00"), line("2", "Yarn #50 Red", "Y-50", 24)],
  shippingCost: "0.00",
  taxRatePct: "0.00",
  adjustments: [],
  notes: null,
  expectedOn: null,
  ...over,
});

const now = new Date("2026-11-17T15:00:00Z");
const timezone = "America/New_York";

describe("poSnapshot / fingerprint", () => {
  it("only what's on the PDF counts; a line taken off isn't there at all", () => {
    const a = po();
    const withGone = po({ lines: [...a.lines, line("9", "Taken off", "GONE", 0)] });
    expect(fingerprint(poSnapshot(withGone))).toBe(fingerprint(poSnapshot(a)));
    expect(fingerprint(poSnapshot(po({ notes: "Ship by sea" })))).not.toBe(
      fingerprint(poSnapshot(a)),
    );
  });
  it("2-decimal and 4-decimal costs are the same price, however they are stored", () => {
    expect(poSnapshot(po({ lines: [line("1", "A", "A", 1, "3.5000")] })).lines[0]!.unitCost).toBe(
      "3.50",
    );
    const asNumbers = po({
      shippingCost: 0,
      taxRatePct: 0,
      lines: po().lines.map((l) => ({ ...l, unitCost: Number(l.unitCost) })),
    });
    expect(fingerprint(poSnapshot(asNumbers))).toBe(fingerprint(poSnapshot(po())));
    expect(poSnapshot(po({ taxRatePct: "8.8750" })).taxRatePct).toBe("8.875");
  });
  it("reads a stored snapshot back, and turns down anything else", () => {
    const snapshot = poSnapshot(po({ notes: "By sea", expectedOn: "2026-12-07" }));
    expect(readSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(readSnapshot(null)).toBeNull();
    expect(readSnapshot({ reference: 4 })).toBeNull();
  });
});

describe("poChanges", () => {
  it("lists quantity, price, added and removed lines in plain words", () => {
    const before = poSnapshot(po());
    const after = poSnapshot(
      po({
        lines: [
          line("1", "Tufting frame", "FRAME", 12, "115.00"),
          line("3", "Yarn #51 Blue", "Y-51", 6),
        ],
        shippingCost: "45.00",
        expectedOn: "2026-12-07",
      }),
    );
    expect(poChanges(before, after)).toEqual([
      "Tufting frame (FRAME): 10 → 12",
      "Tufting frame (FRAME): unit price $120.00 → $115.00",
      "Added Yarn #51 Blue (Y-51) × 6",
      "Removed Yarn #50 Red (Y-50)",
      "Shipping $0.00 → $45.00",
      "Expected delivery Dec 7",
    ]);
  });
  it("says so when tax, adjustments, notes or the reference change", () => {
    expect(
      poChanges(
        poSnapshot(po({ expectedOn: "2026-12-07" })),
        poSnapshot(
          po({
            reference: "HI-202611-NEW000",
            taxRatePct: "8.875",
            adjustments: [{ label: "Pallet fee", amount: "25" }],
            notes: "By sea",
          }),
        ),
      ),
    ).toEqual([
      "PO number is now HI-202611-NEW000 (was HI-202611-ABC123)",
      "Tax 0% → 8.875%",
      "Adjustments updated",
      "Expected delivery date removed",
      "Notes updated",
    ]);
  });
  it("nothing changed, nothing listed", () => {
    expect(poChanges(poSnapshot(po()), poSnapshot(po()))).toEqual([]);
  });
});

describe("composeDefaults", () => {
  it("first send: the default template", () => {
    const d = composeDefaults({
      po: po(),
      contactEmails: ["sam@hillmill.example", "pat@hillmill.example"],
      templates: {},
      senderName: "Dana",
      last: null,
      now,
      timezone,
    });
    expect(d).toMatchObject({
      to: "sam@hillmill.example, pat@hillmill.example",
      subject: "November order – HI-202611-ABC123",
      isResend: false,
    });
    expect(d.body).toBe(
      "Hi Sam and Pat,\n\nPlease find attached purchase order HI-202611-ABC123. Let me know if you have any questions.\n\nThanks,\nDana",
    );
  });

  it("uses the workspace's template, keeping unknown placeholders as typed", () => {
    const d = composeDefaults({
      po: po({ contactName: null }),
      contactEmails: [],
      templates: {
        subject: "PO {{po_reference}} for {{supplier_name}}",
        body: "Hi {{ contact_name }} {{oops}}",
      },
      senderName: "Dana",
      last: null,
      now,
      timezone,
    });
    expect(d).toMatchObject({
      to: "",
      subject: "PO HI-202611-ABC123 for Hill Mill Yarns",
      body: "Hi there {{oops}}",
    });
  });

  it("names the month on the workspace's own calendar", () => {
    const lateOnTheLast = new Date("2026-12-01T03:00:00Z"); // still November in New York
    const subject = (zone: string) =>
      composeDefaults({
        po: po(),
        contactEmails: [],
        templates: {},
        senderName: "D",
        last: null,
        now: lateOnTheLast,
        timezone: zone,
      }).subject;
    expect(subject("America/New_York")).toMatch(/^November/);
    expect(subject("Europe/London")).toMatch(/^December/);
  });

  it("resend after a change: Re: the same subject, saying what changed", () => {
    const sent = poSnapshot(po());
    const d = composeDefaults({
      po: po({
        lines: [
          line("1", "Tufting frame", "FRAME", 12, "120.00"),
          line("2", "Yarn #50 Red", "Y-50", 24),
        ],
      }),
      contactEmails: ["sam@hillmill.example"],
      templates: {},
      senderName: "Dana",
      last: {
        subject: "November order – HI-202611-ABC123",
        sentAt: "2026-11-10T14:00:00Z",
        snapshot: sent,
      },
      now,
      timezone,
    });
    expect(d.isResend).toBe(true);
    expect(d.subject).toBe("Re: November order – HI-202611-ABC123");
    expect(d.changes).toEqual(["Tufting frame (FRAME): 10 → 12"]);
    expect(d.body).toContain("replaces the one I sent on Nov 10");
    expect(d.body).toContain("What changed:\n- Tufting frame (FRAME): 10 → 12");
  });

  it("sending again with no change says so, and doesn't stack Re: Re:", () => {
    const d = composeDefaults({
      po: po(),
      contactEmails: ["sam@hillmill.example"],
      templates: {},
      senderName: "Dana",
      last: {
        subject: "Re: November order",
        sentAt: "2026-11-10T14:00:00Z",
        snapshot: poSnapshot(po()),
      },
      now,
      timezone,
    });
    expect(d.subject).toBe("Re: November order");
    expect(d.body).toContain("again (same as the one I sent on Nov 10)");
  });
});

describe("small things", () => {
  it("first word of the name, else the address", () => {
    expect(firstName("Dana Reyes", "studio@wildthread.example")).toBe("Dana");
    expect(firstName(null, "studio@wildthread.example")).toBe("Studio");
    expect(firstName("  ", "")).toBe("");
  });
  it("words the button the way TuftStock does", () => {
    expect(sendLabel({ isDraft: true, isResend: false, changed: false })).toBe(
      "Send & mark ordered",
    );
    expect(sendLabel({ isDraft: false, isResend: false, changed: false })).toBe("Send");
    expect(sendLabel({ isDraft: false, isResend: true, changed: true })).toBe(
      "Send the changed order",
    );
    expect(sendLabel({ isDraft: false, isResend: true, changed: false })).toBe("Send again");
  });
  it("keeps the template a checked config, with sensible starting words", () => {
    expect(DEFAULT_PO_EMAIL).toMatchObject({ version: 1, cc_me: false, from_name: "" });
    expect(
      parsePoEmail({ version: 1, subject: "  Order {{po_reference}} ", cc_me: true }),
    ).toMatchObject({
      subject: "Order {{po_reference}}",
      cc_me: true,
      body: DEFAULT_PO_EMAIL.body,
    });
    expect(parsePoEmail({ version: 2 })).toEqual(DEFAULT_PO_EMAIL);
    expect(poEmailSchema.safeParse({ version: 1, subject: "" }).success).toBe(false);
    expect(poEmailSchema.safeParse({ version: 1, body: "x".repeat(4001) }).success).toBe(false);
  });
});
