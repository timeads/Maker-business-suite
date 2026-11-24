import { describe, expect, it } from "vitest";
import { headingKey, parseCsv } from "./csv";

const rows = (text: string) => {
  const file = parseCsv(text);
  if (!file.ok) throw new Error(file.error);
  return file.rows;
};

describe("reading a CSV file", () => {
  it("reads headings whatever their capitals and spacing", () => {
    expect(headingKey(" Lead Time (days) ")).toBe("lead_time_days");
    expect(headingKey("PO Number")).toBe("po_number");
    const file = parseCsv("Name, Contact Name ,MOQ\nHill Mill, Dana ,5\n");
    expect(file).toEqual({
      ok: true,
      headers: ["name", "contact_name", "moq"],
      rows: [{ line: 2, cells: { name: "Hill Mill", contact_name: "Dana", moq: "5" } }],
    });
  });

  it("keeps commas, quotes and line breaks that sit inside quotes", () => {
    const out = rows('name,notes\r\n"Loom, Inc.","Says ""hello""\nand more"\r\nNext,plain\r\n');
    expect(out).toEqual([
      { line: 2, cells: { name: "Loom, Inc.", notes: 'Says "hello"\nand more' } },
      // The quoted cell ran over a line, and the count of lines follows it.
      { line: 4, cells: { name: "Next", notes: "plain" } },
    ]);
  });

  it("copes with Excel's start mark, old Mac line ends and a missing last line end", () => {
    expect(rows("﻿name,moq\rA,1\rB,2")).toEqual([
      { line: 2, cells: { name: "A", moq: "1" } },
      { line: 3, cells: { name: "B", moq: "2" } },
    ]);
  });

  it("reads files that use semicolons or tabs between cells", () => {
    expect(rows("name;moq\nA, Inc;2\n")[0].cells).toEqual({ name: "A, Inc", moq: "2" });
    expect(rows("name\tmoq\nA\t2\n")[0].cells).toEqual({ name: "A", moq: "2" });
  });

  it("skips empty lines but still counts them, and fills short rows with nothing", () => {
    expect(rows("name,moq,notes\n\nA,1\n,,\nB\n")).toEqual([
      { line: 3, cells: { name: "A", moq: "1", notes: "" } },
      { line: 5, cells: { name: "B", moq: "", notes: "" } },
    ]);
  });

  it("says so, plainly, when a file can't be read", () => {
    expect(parseCsv("  \n ")).toEqual({ ok: false, error: "That file is empty." });
    const open = parseCsv('name\n"never closed\nmore');
    expect(open.ok).toBe(false);
    if (!open.ok) expect(open.error).toMatch(/never closed/);
  });
});
