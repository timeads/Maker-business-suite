"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  CornerDownRight,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MAX_URLS, docLinks, localStatus, type LinkResult, type LinkStatus } from "@/lib/design";
import { cn } from "@/lib/utils";
import { useBuilder } from "./context";
import { useHost } from "./host";

type Shown = LinkStatus | "checking" | "unchecked";
type Tone = "good" | "bad" | "warn" | "plain";
const WORDS: Record<Shown, [string, Tone]> = {
  ok: ["Working", "good"],
  redirect: ["Working, after a redirect", "good"],
  broken: ["Broken", "bad"],
  empty: ["No link", "bad"],
  placeholder: ["Needs a real address", "bad"],
  "not-https": ["Not https", "warn"],
  "cant-check": ["Cannot be checked", "plain"],
  blocked: ["Readers cannot reach it", "bad"],
  unsafe: ["Not allowed", "bad"],
  checking: ["Checking...", "plain"],
  unchecked: ["Not checked", "plain"],
};
const TONES: Record<Tone, string> = {
  good: "text-mint-ink",
  bad: "text-brick",
  warn: "text-ochre-text",
  plain: "text-muted-foreground",
};

function StatusIcon({ status }: { status: Shown }) {
  const tone = WORDS[status][1];
  const Icon =
    status === "checking"
      ? Loader2
      : tone === "good"
        ? CheckCircle2
        : tone === "bad"
          ? XCircle
          : tone === "warn"
            ? AlertTriangle
            : CircleHelp;
  return (
    <Icon
      className={cn("h-4 w-4 shrink-0", TONES[tone], status === "checking" && "animate-spin")}
      aria-hidden
    />
  );
}

/**
 * Every link in the email with what is known about it. What can be told from the address alone
 * (empty, a stand-in, not https, an email address) is always shown; whether a web address
 * answers is asked of the server, and said plainly when that cannot be done.
 */
export function LinkChecker({ onPick }: { onPick: (blockId: string) => void }) {
  const { doc } = useBuilder();
  const host = useHost();
  const links = useMemo(() => docLinks(doc), [doc]);
  const [live, setLive] = useState<Record<string, LinkResult>>({});
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState("");
  // Only web addresses that look right need fetching, each once however often it is used.
  const toFetch = useMemo(
    () => [...new Set(links.filter((l) => localStatus(l.url) === null).map((l) => l.url.trim()))],
    [links],
  );

  const check = useCallback(async () => {
    if (toFetch.length === 0) return;
    setChecking(true);
    setNote("");
    const answer = await host.checkLinks(toFetch.slice(0, MAX_URLS)).catch(() => ({
      unavailable: "The links could not be checked just now. Check your connection and try again.",
    }));
    if ("unavailable" in answer) setNote(answer.unavailable);
    else {
      setLive(Object.fromEntries(answer.results.map((r) => [r.url, r])));
      if (toFetch.length > MAX_URLS) setNote(`Only the first ${MAX_URLS} links were checked.`);
    }
    setChecking(false);
  }, [toFetch, host]);

  // Checked once when the list is first shown; after that only when asked.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    check();
  }, [check]);

  const rows = links.map((link) => {
    const local = localStatus(link.url);
    const result = local ?? live[link.url.trim()] ?? null;
    const status: Shown = result ? result.status : checking ? "checking" : "unchecked";
    return { link, result, status };
  });
  const count = (tone: Tone) =>
    rows.filter(
      (r) => WORDS[r.status][1] === tone && r.status !== "checking" && r.status !== "unchecked",
    ).length;
  const waiting = rows.filter((r) => r.status === "unchecked").length;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-3" data-link-checker>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm" role="status">
          <span className="font-bold">
            {links.length} {links.length === 1 ? "link" : "links"}.
          </span>{" "}
          {checking
            ? "Checking..."
            : `${count("good")} working, ${count("bad")} to fix, ${count("warn")} to look at${waiting ? `, ${waiting} not checked` : ""}.`}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={check}
          disabled={checking || toFetch.length === 0}
        >
          {checking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}{" "}
          Check links
        </Button>
      </div>
      {note && (
        <p
          className="border-note-border bg-note text-foreground rounded-md border p-2.5 text-xs leading-relaxed"
          data-link-note
        >
          {note} The list below still shows what can be told from each address on its own.
        </p>
      )}
      {links.length === 0 ? (
        <p className="text-muted-foreground border-border rounded-md border border-dashed p-6 text-center text-sm">
          There are no links in this email yet.
        </p>
      ) : (
        <ul className="bg-card divide-border border-border divide-y rounded-md border">
          {rows.map(({ link, result, status }, i) => (
            <li key={`${link.blockId}:${i}`}>
              <button
                type="button"
                onClick={() => onPick(link.blockId)}
                title="Go to this in the email"
                data-link-row={status}
                className="hover:bg-sunken focus-visible:outline-ochre flex w-full items-start gap-3 px-3 py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2"
              >
                <span className="mt-0.5">
                  <StatusIcon status={status} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{link.label}</span>
                  <span className="text-muted-foreground block truncate font-mono text-[11px]">
                    {link.url || "(no address)"}
                  </span>
                  {result?.reason && (
                    <span className="text-muted-foreground block text-xs">{result.reason}</span>
                  )}
                  {result?.finalUrl && (
                    <span className="text-muted-foreground flex items-center gap-1 truncate text-xs">
                      <CornerDownRight className="h-3 w-3 shrink-0" aria-hidden /> Ends up at{" "}
                      <span className="truncate font-mono text-[11px]">{result.finalUrl}</span>
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-right">
                  <span className={cn("block text-xs font-medium", TONES[WORDS[status][1]])}>
                    {WORDS[status][0]}
                  </span>
                  <span className="text-muted-foreground block text-[11px]">
                    {link.sectionName}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground text-[11px] leading-relaxed">
        Click a link to go to it in the email. A link marked working answered just now; it is still
        worth clicking the important ones yourself in a test email.
      </p>
    </div>
  );
}
