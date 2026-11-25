import { CHANNEL_LABELS, type SocialChannel } from "./channels";

/**
 * Who is answering a conversation at Meta, for the team to read. Meta lets
 * one tool at a time reply ("thread control"); what we heard about it is
 * kept on the person (`contacts.thread_control*`, written only by
 * `note_thread_control`). It is a note with a time on it, never a rule: the
 * reply box stays open, and Meta's answer to a send is what counts.
 */
export type ThreadControlNote = {
  state: string | null;
  /** The other tool's Meta app id, when Meta named it. */
  appId: string | null;
  at: string | null;
};

/** Meta's own inboxes, by the app ids its documentation gives for them. */
const META_INBOXES: Record<string, string> = {
  "263902037430900": "Meta Business Suite's inbox",
  "1217981644879628": "Instagram's own inbox",
};

/**
 * A line above the reply box when another tool had the conversation the last
 * time we heard, or null. An app id means nothing to a person, so only Meta's
 * own inboxes are named.
 */
export function controlWords(
  note: ThreadControlNote | null,
  channel: SocialChannel,
  time: (at: string) => string,
): string | null {
  if (!note || note.state !== "other" || !note.at) return null;
  const who = (note.appId && META_INBOXES[note.appId]) || "Another inbox tool";
  return `${who} was answering this conversation on ${CHANNEL_LABELS[channel]} when we last heard (${time(note.at)}). A reply from here may be refused until that tool lets go of it.`;
}
