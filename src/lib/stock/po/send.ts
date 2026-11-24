import { GmailSendError } from "../../connections/providers/google-mail";
import { buildMime, newMessageId, parseRecipients, toRaw } from "./mime";
import { fingerprint, type PoSnapshot } from "./email";

/**
 * Sending one purchase order by email, start to finish. The order of things
 * is what makes a send happen once:
 *
 *   1. claim the send in the database under the page's request key
 *      (`begin_po_email`). A second press with the same key is told what
 *      became of the first and sends nothing.
 *   2. draw the PDF and build the message.
 *   3. ask Gmail, once. (A sign-in Gmail turns away at the door, or a
 *      conversation it can no longer find, took nothing, so those two are
 *      asked again straight away.)
 *   4. write down how it went (`finish_po_email`): sent, failed (Gmail said
 *      no, so the same press may be tried again), or unsure (we never heard
 *      back, so nothing is sent again without a person looking).
 *
 * Everything that touches the outside is handed in, so this is tested with
 * fakes. Nothing here sees a token except to pass it to `send`.
 */

export type SendInput = {
  requestKey: string;
  /** As typed: addresses separated by commas, semicolons or new lines. */
  to: string;
  ccMe: boolean;
  subject: string;
  body: string;
};

export type SendDeps = {
  /** The mailbox the workspace connected. */
  sender: { email: string; name: string | null };
  /** What the order says now (the parts a supplier sees), and its file name. */
  snapshot: PoSnapshot;
  filename: string;
  begin(args: {
    requestKey: string;
    to: string[];
    cc: string[];
    subject: string;
    senderEmail: string;
    messageId: string;
    snapshot: PoSnapshot;
    fingerprint: string;
  }): Promise<{
    id: string;
    state: "new" | "retry" | "sent" | "busy" | "unsure";
    threadId: string | null;
    replyTo: string | null;
  }>;
  /** The order as a PDF, drawn only once a send has been claimed. */
  renderPdf(): Promise<Buffer>;
  /** A sign-in for the mailbox; `fresh` renews it first. Never logged. */
  accessToken(fresh: boolean): Promise<string>;
  send(
    accessToken: string,
    raw: string,
    threadId: string | null,
  ): Promise<{ id: string; threadId: string }>;
  finish(args: {
    id: string;
    outcome: "sent" | "failed" | "unsure";
    gmailMessageId?: string;
    gmailThreadId?: string;
    error?: string;
  }): Promise<{ markedOrdered: boolean }>;
  /** For the Message-ID; fixed in tests. */
  random?: string;
};

export type SendResult =
  | { ok: true; to: string[]; cc: string[]; markedOrdered: boolean; repeated: boolean }
  | { ok: false; error: string; canRetry: boolean };

/** Thrown by `begin`, `renderPdf` or `accessToken` with words meant for the person. */
export class SendRefused extends Error {}

export const MAX_BODY = 20_000;

/** Checks what was typed. Returns the addresses, or the reason it can't go. */
export function checkSendInput(
  input: SendInput,
  senderEmail: string,
): { to: string[]; cc: string[]; subject: string; body: string } | { error: string } {
  const { ok: to, bad } = parseRecipients(input.to);
  if (bad.length > 0) return { error: `Not an email address: ${bad.join(", ")}` };
  if (to.length === 0) return { error: "Add the supplier's email address." };
  if (to.length > 10) return { error: "That's more than ten addresses. Send to ten at most." };
  const subject = input.subject.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  if (!subject) return { error: "Add a subject." };
  if (subject.length > 300) return { error: "That subject is too long." };
  if (!input.body.trim()) return { error: "Add a message." };
  if (input.body.length > MAX_BODY) return { error: "That message is too long." };
  const lower = to.map((address) => address.toLowerCase());
  const me = senderEmail.toLowerCase();
  return {
    to: lower,
    // A copy to yourself, unless you are already one of the people it goes to.
    cc: input.ccMe && !lower.includes(me) ? [me] : [],
    subject,
    body: input.body,
  };
}

export async function sendPoEmail(input: SendInput, deps: SendDeps): Promise<SendResult> {
  const checked = checkSendInput(input, deps.sender.email);
  if ("error" in checked) return { ok: false, error: checked.error, canRetry: true };
  const { to, cc, subject, body } = checked;
  const messageId = newMessageId(deps.sender.email, deps.random);

  let claim: Awaited<ReturnType<SendDeps["begin"]>>;
  try {
    claim = await deps.begin({
      requestKey: input.requestKey,
      to,
      cc,
      subject,
      senderEmail: deps.sender.email,
      messageId,
      snapshot: deps.snapshot,
      fingerprint: fingerprint(deps.snapshot),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof SendRefused ? err.message : "That didn't send. Please try again.",
      canRetry: true,
    };
  }
  if (claim.state === "sent") {
    return { ok: true, to, cc, markedOrdered: false, repeated: true };
  }
  if (claim.state === "busy") {
    return {
      ok: false,
      error: "This email is being sent right now. Give it a moment, then refresh the page.",
      canRetry: false,
    };
  }
  if (claim.state === "unsure") {
    return {
      ok: false,
      error:
        "We never heard back from Gmail about this email, so it may have gone. Check your Sent folder in Gmail. If it isn't there, refresh this page and send it again.",
      canRetry: false,
    };
  }

  // Claimed. From here on, whatever happens is written down.
  const fail = async (error: string, outcome: "failed" | "unsure"): Promise<SendResult> => {
    await deps.finish({ id: claim.id, outcome, error }).catch(() => undefined);
    return { ok: false, error, canRetry: outcome === "failed" };
  };

  let raw: (inReplyTo: string | null) => string;
  let token: string;
  try {
    const pdf = await deps.renderPdf();
    raw = (inReplyTo) =>
      toRaw(
        buildMime({
          from: { name: deps.sender.name, email: deps.sender.email },
          to,
          cc,
          subject,
          text: body,
          attachment: { filename: deps.filename, contentType: "application/pdf", content: pdf },
          messageId,
          inReplyTo,
        }),
      );
    token = await deps.accessToken(false);
  } catch (err) {
    // Nothing has been asked of Gmail yet, so nothing went.
    return fail(
      err instanceof SendRefused
        ? err.message
        : "We couldn't get the email ready, so nothing was sent. Please try again.",
      "failed",
    );
  }

  let threadId = claim.threadId;
  let replyTo = claim.threadId ? claim.replyTo : null;
  let renewed = false;
  for (;;) {
    try {
      const sent = await deps.send(token, raw(replyTo), threadId);
      let markedOrdered = false;
      try {
        ({ markedOrdered } = await deps.finish({
          id: claim.id,
          outcome: "sent",
          gmailMessageId: sent.id,
          gmailThreadId: sent.threadId,
        }));
      } catch {
        // It went; only our note of it didn't. Say so rather than invite a second send.
        return {
          ok: false,
          error:
            "The email was sent, but we couldn't make a note of it here. Don't send it again; refresh the page.",
          canRetry: false,
        };
      }
      return { ok: true, to, cc, markedOrdered, repeated: false };
    } catch (err) {
      if (!(err instanceof GmailSendError)) {
        return fail(
          "Something went wrong while sending, and we can't tell whether it went. Check your Sent folder before sending again.",
          "unsure",
        );
      }
      // Turned away at the door: nothing went, so asking again is safe. Once each.
      if (err.fix === "stale" && !renewed) {
        renewed = true;
        try {
          token = await deps.accessToken(true);
          continue;
        } catch (inner) {
          return fail(
            inner instanceof SendRefused
              ? inner.message
              : "Gmail needs reconnecting, under Connections. Nothing was sent.",
            "failed",
          );
        }
      }
      if (err.fix === "thread" && threadId) {
        threadId = null;
        replyTo = null;
        continue;
      }
      if (err.fix === "stale") {
        return fail("Gmail needs reconnecting, under Connections. Nothing was sent.", "failed");
      }
      return fail(err.message, err.sent === "no" ? "failed" : "unsure");
    }
  }
}
