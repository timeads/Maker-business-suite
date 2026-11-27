import { shopItems, type ConnectionFact } from "../setup/connection";
import type { SetupItem, SetupStep } from "../setup/items";
import {
  CHANNEL_LABELS,
  SOCIAL_CHANNELS,
  type ChannelState,
  type SocialChannel,
} from "./social/channels";

/**
 * "Finish setting up the help desk": what still stands between the
 * workspace and every customer's message landing here and being answered,
 * worked out on read (docs/setup-pattern.md). Pure: the facts come from
 * `setup-data.ts`, or from what the inbox already read. Nothing is stored but
 * a person's "Not now".
 *
 * Required: mail really arriving, and a channel that was switched on but
 * can't carry messages. Everything else (saved replies, rules, the undo
 * wait, Instagram and Facebook, the automatic first reply, the manual, the
 * help centre, the shop beside a conversation) is optional and offered on
 * the guided page only. The automatic reply's words are only ever written
 * by a person in its own form: this checklist links there and nothing more.
 */

export const HELPDESK_TOOL = "helpdesk";

export const HELPDESK_STEPS: readonly SetupStep[] = [
  { id: "email", title: "Your email coming in" },
  { id: "replies", title: "Answering quickly" },
  { id: "channels", title: "Instagram and Facebook" },
  { id: "automatic", title: "A reply while you're away" },
  { id: "manual", title: "Your manual and help centre" },
  { id: "shop", title: "Your shop beside each conversation" },
  { id: "review", title: "Have a look" },
];

export type HelpdeskSetupFacts = {
  now: Date;
  /** Incoming email is switched on in this environment, so the desk has an address. */
  address: boolean;
  /** An email has come in at least once. Null when not known. */
  emailReceived: boolean | null;
  ownAddresses: number;
  undoSeconds: number;
  templates: number;
  rules: number;
  /** Instagram and Facebook: offered here (the app's keys are set), and where each stands. */
  social: {
    offered: boolean;
    messages: Record<SocialChannel, ChannelState>;
    comments: Record<SocialChannel, ChannelState>;
  };
  /** Any channel's automatic reply is switched on. */
  autoReplyOn: boolean;
  manual: { saved: boolean };
  helpCentre: { on: boolean };
  shop: ConnectionFact | null;
};

const list = (words: readonly string[]) =>
  words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

/** The open items, in the order the guided setup takes them. */
export function helpdeskSetupItems(facts: HelpdeskSetupFacts): SetupItem[] {
  const items: SetupItem[] = [];

  if (facts.address && facts.emailReceived === false) {
    items.push({
      id: "email.forward",
      title: "Send your support email to the help desk",
      why: "Nothing arrives here until it does. Forward your own address to the help desk's, and this ticks itself off with the first email that comes in.",
      to: "helpdesk/setup#email",
      action: "See how",
      facts: "none",
      step: "email",
      managersOnly: true,
    });
  }

  // Switched on but can't carry anything: messages would go unanswered.
  const blocked = SOCIAL_CHANNELS.flatMap((channel) => [
    ...(facts.social.messages[channel] === "blocked"
      ? [`${CHANNEL_LABELS[channel]} messages`]
      : []),
    ...(facts.social.comments[channel] === "blocked"
      ? [`${CHANNEL_LABELS[channel]} comments`]
      : []),
  ]);
  if (blocked.length > 0) {
    items.push({
      id: "channels.blocked",
      title: `${list(blocked)} ${blocked.length === 1 ? "is" : "are"} switched on but can't come in`,
      why: "Facebook isn't letting them through: the connection needs renewing, or a permission wasn't ticked. Until then nothing new arrives from there.",
      names: blocked,
      to: "settings/helpdesk/channels",
      action: "Sort it out",
      facts: blocked.join(","),
      step: "channels",
      managersOnly: true,
    });
  }

  // Optional from here on: offered on the guided page, never on the card.
  if (facts.emailReceived && facts.ownAddresses === 0) {
    items.push({
      id: "email.own",
      title: "Tell us the address you forward from",
      why: "Then “Reply all” never copies your own address in, so a reply doesn't come straight back to the desk.",
      to: "settings/helpdesk",
      action: "Add it",
      facts: "none",
      step: "email",
      optional: true,
      managersOnly: true,
    });
  }
  if (facts.undoSeconds === 0) {
    items.push({
      id: "email.undo",
      title: "Give yourself a moment to take an email back",
      why: "A sent reply waits a few seconds before it really goes, so a slip can be undone.",
      to: "settings/helpdesk#behaviour",
      action: "Set the wait",
      facts: "0",
      step: "replies",
      optional: true,
      managersOnly: true,
    });
  }
  if (facts.templates === 0) {
    items.push({
      id: "replies.saved",
      title: "Save the answers you give often",
      why: "Pick one when replying instead of typing it again, and Claude follows their tone when it drafts.",
      to: "settings/helpdesk",
      action: "Add a saved reply",
      facts: "none",
      step: "replies",
      optional: true,
      managersOnly: true,
    });
  }
  if (facts.rules === 0) {
    items.push({
      id: "replies.rules",
      title: "Sort new email by itself",
      why: "Tag a conversation, mark it urgent or hand it to the right person by the words in it.",
      to: "settings/helpdesk",
      action: "Add a rule",
      facts: "none",
      step: "replies",
      optional: true,
      managersOnly: true,
    });
  }
  const anySocial = SOCIAL_CHANNELS.some(
    (c) => facts.social.messages[c] !== "off" || facts.social.comments[c] !== "off",
  );
  if (facts.social.offered && !anySocial) {
    items.push({
      id: "channels.social",
      title: "Answer Instagram and Facebook messages here too",
      why: "Messages and comments on your posts sit beside email and are answered from the same reply box.",
      to: "settings/helpdesk/channels",
      action: "Switch them on",
      facts: "off",
      step: "channels",
      optional: true,
      managersOnly: true,
    });
  }
  if (!facts.autoReplyOn) {
    items.push({
      id: "automatic.reply",
      title: "Let people know their message arrived",
      why: "A short reply sent by itself, in words you write and nothing else, always or only outside your opening hours.",
      to: "settings/helpdesk/auto-replies",
      action: "Write it",
      facts: "off",
      step: "automatic",
      optional: true,
      managersOnly: true,
    });
  }
  if (!facts.manual.saved) {
    items.push({
      id: "manual",
      title: "Keep a manual of your answers",
      why: "Topics written up from finished conversations, for the team and the reply box. Nothing in it is published by itself.",
      to: "settings/helpdesk/manual",
      action: "Set it up",
      facts: "never",
      step: "manual",
      optional: true,
      managersOnly: true,
    });
  }
  if (!facts.helpCentre.on) {
    items.push({
      id: "help-centre",
      title: "Open a help centre for customers",
      why: "Public pages for the help articles you choose to publish, so people can find an answer before they write.",
      to: "settings/helpdesk/help-centre",
      action: "Have a look",
      facts: "off",
      step: "manual",
      optional: true,
      managersOnly: true,
    });
  }
  // The shop fills in the customer's orders beside a conversation: nice, never needed.
  items.push(
    ...shopItems(facts.shop, facts.now, {
      what: "A customer's orders show beside their message, from what your shop sends us.",
      step: "shop",
      readAgain: "connections",
    }).map((item) => ({ ...item, optional: true })),
  );
  return items;
}
