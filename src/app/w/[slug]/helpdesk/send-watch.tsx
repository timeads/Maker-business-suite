"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { draftKey } from "@/lib/helpdesk/drafts";
import { outboxWords, secondsLeft, type OutboxRow } from "@/lib/helpdesk/outbox";
import { richToText, type RichDoc } from "@/lib/helpdesk/rich";
import { discardEmptyTicket, dismissSend, undoSend } from "./actions";
import { INSERT_EVENT, QUEUED_EVENT, RESTORE_EVENT } from "./composer";

type Queued = {
  id: string;
  seconds: number;
  ticketId: string;
  number: number;
  forward: boolean;
  draft: string;
};

/** Puts a taken-back email's words into this browser's drafts and tells the reply box. */
function restoreDraft(ticketId: string, draft: string) {
  try {
    localStorage.setItem(draftKey(ticketId), draft);
  } catch {
    // A browser that refuses storage can't bring the words back.
  }
  window.dispatchEvent(new CustomEvent(RESTORE_EVENT, { detail: { ticketId } }));
}

/**
 * The few seconds after pressing send. The email is waiting on the server,
 * which sends it when the wait runs out whether or not this page is still
 * open; this only counts down and offers "Undo", which asks the server to
 * take it back. It stays up while the person moves on to the next
 * conversation.
 */
export function SendWatch({ slug, base }: { slug: string; base: string }) {
  const router = useRouter();
  const [queued, setQueued] = useState<Queued | null>(null);
  const [left, setLeft] = useState(0);
  const [words, setWords] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const onQueued = (event: Event) => {
      const detail = (event as CustomEvent<Queued>).detail;
      if (!detail?.id) return;
      setWords(null);
      setQueued(detail);
      setLeft(detail.seconds);
    };
    window.addEventListener(QUEUED_EVENT, onQueued);
    return () => window.removeEventListener(QUEUED_EVENT, onQueued);
  }, []);

  useEffect(() => {
    if (!queued) return;
    const until = Date.now() + queued.seconds * 1000;
    const tick = setInterval(() => {
      const now = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setLeft(now);
      if (now === 0) {
        clearInterval(tick);
        setQueued(null);
        // The worker sends within a few seconds of the wait ending; look again then.
        timers.current.push(setTimeout(() => router.refresh(), 4000));
        timers.current.push(setTimeout(() => router.refresh(), 12000));
      }
    }, 250);
    return () => clearInterval(tick);
  }, [queued, router]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const undo = () => {
    const mail = queued;
    if (!mail) return;
    start(async () => {
      const taken = await undoSend(slug, mail.id);
      setQueued(null);
      if (!taken) {
        setWords("Too late to take that one back: it has gone.");
        router.refresh();
        return;
      }
      restoreDraft(mail.ticketId, mail.draft);
      setWords("Taken back. Nothing was sent.");
      router.push(`${base}?view=all&t=${mail.number}`);
    });
  };

  if (!queued && !words) return null;
  return (
    <div
      role="status"
      className="bg-teal text-on-teal fixed bottom-[72px] left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-md px-4 py-2.5 text-sm shadow-lg md:bottom-6"
    >
      {queued ? (
        <>
          <span>
            {queued.forward ? "Forwarding" : "Sending"} #{queued.number} in {left}s
          </span>
          <Button type="button" size="sm" onClick={undo} disabled={busy}>
            Undo
          </Button>
        </>
      ) : (
        <>
          <span>{words}</span>
          <button
            type="button"
            className="font-semibold underline underline-offset-2"
            onClick={() => setWords(null)}
          >
            OK
          </button>
        </>
      )}
    </div>
  );
}

/**
 * At the foot of a conversation: email that is waiting to go, going, or that
 * didn't go as planned. A waiting one can still be taken back; a failed one
 * gives its words back to the reply box.
 */
export function OutboxNotices({
  slug,
  rows,
  names,
}: {
  slug: string;
  rows: OutboxRow[];
  names: Record<string, string>;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [now, setNow] = useState(() => Date.now());
  const waiting = rows.some((row) => row.state === "waiting" || row.state === "sending");
  useEffect(() => {
    if (!waiting) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    // What is waiting goes without this page; look again until it has.
    const look = setInterval(() => router.refresh(), 6000);
    return () => {
      clearInterval(tick);
      clearInterval(look);
    };
  }, [waiting, router]);
  if (rows.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => {
        const bad = row.state === "failed" || row.state === "unsure";
        const who = row.author_id ? names[row.author_id] : null;
        return (
          <li
            key={row.id}
            role={bad ? "alert" : "status"}
            className={
              bad
                ? "bg-brick-soft border-brick/30 ml-auto w-full max-w-[76ch] rounded-lg border px-4 py-3 text-sm"
                : "bg-out border-out-border ml-auto w-full max-w-[76ch] rounded-lg border border-dashed px-4 py-3 text-sm"
            }
          >
            <p>
              {outboxWords(row)}
              {row.state === "waiting" && ` (${secondsLeft(row.send_at, now)}s)`}
              {who ? ` Written by ${who}.` : ""}
            </p>
            {row.summary?.preview && (
              <p className="font-read text-muted-foreground mt-1 line-clamp-2 text-xs">
                {row.summary.preview}
              </p>
            )}
            <p className="mt-2 flex flex-wrap gap-1.5">
              {row.state === "waiting" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    start(async () => {
                      await undoSend(slug, row.id);
                      router.refresh();
                    })
                  }
                >
                  Don&apos;t send
                </Button>
              )}
              {row.state === "failed" && Array.isArray(row.doc) && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    const text = richToText(row.doc as RichDoc);
                    window.dispatchEvent(new CustomEvent(INSERT_EVENT, { detail: text }));
                    start(async () => {
                      await dismissSend(slug, row.id);
                      router.refresh();
                    });
                  }}
                >
                  Put the words back in the box
                </Button>
              )}
              {bad && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    start(async () => {
                      await dismissSend(slug, row.id);
                      router.refresh();
                    })
                  }
                >
                  Dismiss
                </Button>
              )}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

/** For a conversation that was started and never written: throw it away. */
export function DiscardEmpty({
  slug,
  ticketId,
  back,
}: {
  slug: string;
  ticketId: string;
  back: string;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() =>
          start(async () => {
            const result = await discardEmptyTicket(slug, ticketId);
            if (result.error) setProblem(result.error);
            else router.push(back);
          })
        }
      >
        {busy ? "Removing…" : "Remove this empty conversation"}
      </Button>
      {problem && (
        <span role="alert" className="text-brick text-xs">
          {problem}
        </span>
      )}
    </span>
  );
}
