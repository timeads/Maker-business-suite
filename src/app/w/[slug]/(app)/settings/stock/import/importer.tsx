"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Label, Select } from "@/components/ui/input";
import { parseCsv } from "@/lib/stock/import/csv";
import { MAX_IMPORT_BYTES, guessImportKind, type ImportKind } from "@/lib/stock/import/files";
import { IMPORT_GUIDE, IMPORT_ORDER } from "@/lib/stock/import/guide";
import { countLines, plural } from "@/lib/stock/import/words";
import { lookAtImport, runImport, type ImportState } from "./actions";

/**
 * Choose a kind of file, pick the file, look at what it would do, then bring
 * it in. The file is read here in the browser and sent as text with each
 * step; it isn't kept anywhere. With `only`, it takes that one kind of file
 * (the Suppliers page keeps it under its table).
 */
export function Importer({ slug, only }: { slug: string; only?: ImportKind }) {
  const [kind, setKind] = useState<ImportKind>(only ?? "suppliers");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [state, setState] = useState<ImportState>({});
  const [key, setKey] = useState("");
  /** Set when the file was plainly another kind than the one chosen, and we read it as that. */
  const [switched, setSwitched] = useState<ImportKind | null>(null);
  const [busy, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const guide = IMPORT_GUIDE[kind];

  const reset = () => {
    setFile(null);
    setState({});
    setSwitched(null);
    if (input.current) input.current.value = "";
  };

  const choose = async (picked: File | undefined) => {
    setState({});
    setFile(null);
    if (!picked) return;
    if (picked.size > MAX_IMPORT_BYTES) {
      setState({
        error: `That file is bigger than ${MAX_IMPORT_BYTES / 1_000_000} MB. Split it into smaller files and bring them in one at a time.`,
      });
      return;
    }
    const text = await picked.text();
    // The headings say what the file is. If they plainly say another kind than the
    // one chosen, read it as what it is and say so, rather than as the wrong thing.
    const parsed = parseCsv(text);
    const guess = parsed.ok ? guessImportKind(parsed.headers) : null;
    let as = kind;
    setSwitched(null);
    if (guess && guess !== kind) {
      if (only) {
        setState({
          error: `That looks like a ${IMPORT_GUIDE[guess].title.toLowerCase()} file, and this box takes ${IMPORT_GUIDE[only].title.toLowerCase()}. Bring it in under Settings → Stock → Bring your records across.`,
        });
        return;
      }
      as = guess;
      setKind(guess);
      setSwitched(guess);
    }
    setFile({ name: picked.name, text });
    // A fresh key for this look: pressing "Bring these in" twice sends the same one.
    setKey(crypto.randomUUID());
    start(async () => setState(await lookAtImport(slug, as, picked.name, text)));
  };

  const look = state.look;
  const done = state.done;
  const worthIt = look ? look.counts.new + look.counts.changed > 0 : false;

  return (
    <div className="flex flex-col gap-4">
      <div className={only ? "flex flex-col" : "grid gap-3 sm:grid-cols-[14rem_1fr]"}>
        {!only && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="import-kind">What&apos;s in the file</Label>
            <Select
              id="import-kind"
              value={kind}
              disabled={busy}
              onChange={(event) => {
                setKind(event.target.value as ImportKind);
                reset();
              }}
            >
              {IMPORT_ORDER.map((value, index) => (
                <option key={value} value={value}>
                  {index + 1}. {IMPORT_GUIDE[value].title}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="import-file">The file (CSV)</Label>
          <input
            ref={input}
            id="import-file"
            type="file"
            accept=".csv,text/csv,text/plain"
            disabled={busy}
            onChange={(event) => void choose(event.target.files?.[0])}
            className="border-input bg-card file:bg-secondary file:text-secondary-foreground h-9 rounded-md border text-sm file:mr-3 file:h-full file:border-0 file:px-3 file:text-sm"
          />
        </div>
      </div>
      {!only && (
        <p className="text-muted-foreground font-read text-sm">
          {guide.about} {guide.matchedBy}
        </p>
      )}

      {switched && !done && (
        <FormMessage kind="success">
          That&apos;s a {IMPORT_GUIDE[switched].title.toLowerCase()} file, so we&apos;ve read it as
          one.
        </FormMessage>
      )}

      {busy && !done && (
        <p className="text-muted-foreground text-sm" role="status">
          {look ? "Bringing it in…" : "Reading the file…"}
        </p>
      )}
      <FormMessage>{state.error}</FormMessage>

      {done && (
        <FormMessage kind="success">
          {done.repeated
            ? `“${done.fileName}” was already brought in by your first press: `
            : `“${done.fileName}” is in: `}
          {countLines(done.kind, done.counts, true).join("; ")}.
        </FormMessage>
      )}

      {look && !done && (
        <div className="border-border flex flex-col gap-3 rounded-lg border p-4">
          {state.moved && (
            <FormMessage>
              Your records changed since you looked, so nothing was brought in. Here is what the
              file would do now.
            </FormMessage>
          )}
          <p className="text-sm font-semibold">
            “{look.fileName}”: {plural(look.read, "row")} read, {plural(look.usable, "row")} we can
            use{look.problemCount > 0 ? `, ${plural(look.problemCount, "row")} left out` : ""}.
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {countLines(look.kind, look.counts, false).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {look.notes.map((note) => (
            <p key={note} className="text-muted-foreground font-read text-sm">
              {note}
            </p>
          ))}
          {look.problemCount > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-semibold">Left out, and why</p>
              <ul className="bg-sunken max-h-64 overflow-y-auto rounded-md p-3 text-sm">
                {look.problems.map((problem, index) => (
                  <li key={index} className="py-0.5">
                    <span className="text-muted-foreground tabular-nums">Line {problem.line}:</span>{" "}
                    <span className="font-read">{problem.reason}</span>
                  </li>
                ))}
                {look.problemCount > look.problems.length && (
                  <li className="text-muted-foreground py-0.5">
                    …and {plural(look.problemCount - look.problems.length, "more row")}.
                  </li>
                )}
              </ul>
              <p className="text-muted-foreground text-xs">
                You can fix those rows in the file and bring it in again later: rows that are
                already in won&apos;t be added twice.
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy || !file || !worthIt}
              onClick={() => {
                if (!file) return;
                start(async () =>
                  setState(await runImport(slug, look.kind, file.name, file.text, key, look.seen)),
                );
              }}
            >
              {busy ? "Bringing it in…" : "Bring these in"}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={reset}>
              Choose another file
            </Button>
          </div>
        </div>
      )}
      {done && (
        <div>
          <Button type="button" variant="outline" onClick={reset}>
            Bring in another file
          </Button>
        </div>
      )}
    </div>
  );
}
