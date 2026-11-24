/**
 * Reads a spreadsheet saved as CSV. Pure, and with no library: quoted cells,
 * doubled quotes, commas and line breaks inside quotes, Windows or Unix line
 * ends, the invisible mark Excel puts at the start, and files that use
 * semicolons or tabs between cells instead of commas.
 */

export type CsvRow = {
  /** The line of the file the row starts on, counting the heading as line 1. */
  line: number;
  /** Cells by heading, trimmed. A heading the row has no cell for reads "". */
  cells: Record<string, string>;
};

export type CsvFile =
  { ok: true; headers: string[]; rows: CsvRow[] } | { ok: false; error: string };

/** "Lead Time (days)" → "lead_time_days": headings are matched whatever their capitals or spacing. */
export const headingKey = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

function delimiterOf(firstLine: string): string {
  const count = (mark: string) => firstLine.split(mark).length - 1;
  const [best] = [",", ";", "\t"].sort((a, b) => count(b) - count(a));
  return count(best) > 0 ? best : ",";
}

/** Splits the text into records of cells, noting the line each starts on. */
function records(text: string, delimiter: string): { line: number; cells: string[] }[] | null {
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  let startLine = 1;
  const endCell = () => {
    cells.push(wasQuoted ? cell : cell.trim());
    cell = "";
    wasQuoted = false;
  };
  const endRecord = () => {
    endCell();
    if (cells.some((value) => value !== "")) out.push({ line: startLine, cells });
    cells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      quoted = true;
      wasQuoted = true;
      cell = "";
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      startLine = line;
    } else {
      cell += ch;
    }
  }
  if (quoted) return null;
  endRecord();
  return out;
}

export function parseCsv(input: string): CsvFile {
  const text = input.replace(/^﻿/, "");
  if (text.trim() === "") return { ok: false, error: "That file is empty." };
  const firstLine = text.split(/\r?\n|\r/, 1)[0];
  const all = records(text, delimiterOf(firstLine));
  if (!all) {
    return {
      ok: false,
      error:
        "A quoted cell in that file is never closed, so we can't tell where its rows end. Save it as CSV again and try once more.",
    };
  }
  const [head, ...rest] = all;
  if (!head) return { ok: false, error: "That file is empty." };
  const headers = head.cells.map(headingKey);
  if (headers.every((heading) => heading === "")) {
    return { ok: false, error: "The first line of that file should name its columns." };
  }
  return {
    ok: true,
    headers: headers.filter(Boolean),
    rows: rest.map((record) => ({
      line: record.line,
      cells: Object.fromEntries(
        headers
          .map((heading, index) => [heading, (record.cells[index] ?? "").trim()] as const)
          .filter(([heading]) => heading !== ""),
      ),
    })),
  };
}
