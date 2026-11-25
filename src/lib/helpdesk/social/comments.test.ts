import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { scopesFor } from "../../connections/meta-access";
import type { TokenDeps } from "../../connections/tokens";
import { textToRich } from "../rich";
import {
  COMMENT_LIMITS,
  channelSettingsSchema,
  commentAbilities,
  commentScopesAllow,
  commentState,
  parseChannelSettings,
  type ChannelSettings,
  type MetaConnectionFacts,
} from "./channels";
import {
  POST_EXCERPT_MAX,
  PRIVATE_REPLY_WINDOW_MS,
  commentSubject,
  conversationWords,
  hasOwnWord,
  isNoise,
  latestComment,
  postExcerpt,
  postLink,
  privateReplyState,
  privateReplyWords,
  startsConversation,
} from "./comments";
import { socialPayloadSchema } from "./deliver";
import { parseMetaPayload, type CommentEvent } from "./events";
import {
  MetaRefused,
  MetaUnsure,
  deleteComment,
  readPost,
  refusalWords,
  replyToComment,
  sendPrivateReply,
  setCommentHidden,
  subscribedFieldsFor,
} from "./graph";
import { RetryLater, processMetaPayload, type CommentFiled, type IntakeDeps } from "./intake";
import { SocialNotSent, sendCommentReply, type ChannelFacts } from "./server";

// Everything here is made up: ids, names, words. Nothing real is ever in a test.
const NOW = Date.parse("2026-11-25T15:00:00Z");
const PAGE = "1000000000000001";
const IG = "1784000000000002";
const PERSON = "9000000000000003";
const POST = `${PAGE}_500000000000001`;
const MEDIA = "1790000000000009";

const feed = (value: Record<string, unknown>, account = PAGE) => ({
  object: "page",
  entry: [{ id: account, time: 1795000000, changes: [{ field: "feed", value }] }],
});
const fbComment = (extra: Record<string, unknown> = {}) => ({
  item: "comment",
  verb: "add",
  comment_id: `${POST}_700`,
  post_id: POST,
  parent_id: POST,
  from: { id: PERSON, name: "A Made Up Person" },
  message: "Do you ship to Canada?",
  created_time: Math.floor(NOW / 1000) - 60,
  ...extra,
});
const igDelivery = (value: Record<string, unknown>, field = "comments", account = IG) => ({
  object: "instagram",
  entry: [{ id: account, time: Math.floor(NOW / 1000) - 30, changes: [{ field, value }] }],
});
const igComment = (extra: Record<string, unknown> = {}) => ({
  id: "17900000000000111",
  from: { id: PERSON, username: "a_made_up_person" },
  media: { id: MEDIA, media_product_type: "FEED" },
  text: "Is this back in stock?",
  ...extra,
});
const only = (payload: unknown) => {
  const events = parseMetaPayload(payload, NOW);
  expect(events).toHaveLength(1);
  return events[0] as CommentEvent;
};

describe("reading comments out of a delivery", () => {
  it("reads a comment on a Facebook post: who, what, on which post", () => {
    expect(only(feed(fbComment()))).toEqual({
      type: "comment",
      channel: "facebook",
      accountId: PAGE,
      at: new Date(NOW - 60_000).toISOString(),
      commentId: `${POST}_700`,
      personId: PERSON,
      name: "A Made Up Person",
      handle: null,
      postId: POST,
      // A top-level comment names its post as its parent: that is no parent comment.
      parentId: null,
      text: "Do you ship to Canada?",
      media: [],
      summary: null,
      own: false,
      edited: false,
    });
  });

  it("reads a reply under a comment, with the comment it answers", () => {
    const event = only(
      feed(fbComment({ comment_id: `${POST}_701`, parent_id: `${POST}_700`, message: "Thanks!" })),
    );
    expect(event).toMatchObject({ type: "comment", parentId: `${POST}_700`, text: "Thanks!" });
  });

  it("reads a picture on a Facebook comment as a file to fetch, with a few words of ours", () => {
    const event = only(
      feed(fbComment({ message: "", photo: "https://scontent.xx.fbcdn.net/v/made-up.jpg" })),
    );
    expect(event).toMatchObject({
      text: "",
      summary: "Posted a photo",
      media: [{ kind: "image", url: "https://scontent.xx.fbcdn.net/v/made-up.jpg" }],
    });
    // Nothing to say and nothing to show: nothing to file.
    expect(parseMetaPayload(feed(fbComment({ message: "" })), NOW)).toEqual([]);
  });

  it("reads an edit as the same comment with new words", () => {
    const event = only(feed(fbComment({ verb: "edited", message: "Do you ship to Mexico?" })));
    expect(event).toMatchObject({
      type: "comment",
      commentId: `${POST}_700`,
      edited: true,
      text: "Do you ship to Mexico?",
    });
  });

  it("reads a removal, a hide and an unhide", () => {
    expect(only(feed(fbComment({ verb: "remove" })))).toMatchObject({
      type: "comment_removed",
      commentId: `${POST}_700`,
    });
    // A removal may come without its author: it still names the comment.
    expect(
      only(feed({ item: "comment", verb: "remove", comment_id: "c9", post_id: POST })),
    ).toEqual(expect.objectContaining({ type: "comment_removed", commentId: "c9" }));
    expect(only(feed(fbComment({ verb: "hide" })))).toMatchObject({
      type: "comment_hidden",
      hidden: true,
    });
    expect(only(feed(fbComment({ verb: "unhide" })))).toMatchObject({
      type: "comment_hidden",
      hidden: false,
    });
  });

  it("marks the Page's own comment as its own", () => {
    const event = only(
      feed(fbComment({ from: { id: PAGE, name: "A Made Up Page" }, parent_id: `${POST}_700` })),
    );
    expect(event).toMatchObject({ type: "comment", own: true, parentId: `${POST}_700` });
  });

  it("leaves out everything else on a Page's feed", () => {
    for (const value of [
      { item: "post", verb: "add", post_id: POST, from: { id: PERSON }, message: "A visitor post" },
      { item: "reaction", verb: "add", post_id: POST, reaction_type: "like", from: { id: PERSON } },
      { item: "share", verb: "add", post_id: POST },
      { item: "status", verb: "add", post_id: POST, message: "Our own post" },
      fbComment({ verb: "follow" }),
      // No author: there is nobody to put it under.
      fbComment({ from: undefined }),
      fbComment({ comment_id: undefined }),
    ]) {
      expect(parseMetaPayload(feed(value), NOW)).toEqual([]);
    }
    // And a field that isn't the feed at all.
    expect(
      parseMetaPayload(
        {
          object: "page",
          entry: [{ id: PAGE, changes: [{ field: "ratings", value: fbComment() }] }],
        },
        NOW,
      ),
    ).toEqual([]);
  });

  it("reads a comment on an Instagram post, with the username it arrives with", () => {
    expect(only(igDelivery(igComment()))).toEqual({
      type: "comment",
      channel: "instagram",
      accountId: IG,
      at: new Date(NOW - 30_000).toISOString(),
      commentId: "17900000000000111",
      personId: PERSON,
      name: null,
      handle: "a_made_up_person",
      postId: MEDIA,
      parentId: null,
      text: "Is this back in stock?",
      media: [],
      summary: null,
      own: false,
      edited: false,
    });
  });

  it("reads Instagram's other spelling of the comment's id, and a reply's parent", () => {
    const event = only(
      igDelivery(
        igComment({
          id: undefined,
          comment_id: "17900000000000222",
          parent_id: "17900000000000111",
        }),
      ),
    );
    expect(event).toMatchObject({ commentId: "17900000000000222", parentId: "17900000000000111" });
  });

  it("files a comment on an ad like any other, and marks the account's own", () => {
    const ad = only(
      igDelivery(igComment({ media: { id: MEDIA, ad_id: "600", ad_title: "A made up ad" } })),
    );
    expect(ad).toMatchObject({ type: "comment", postId: MEDIA });
    const own = only(igDelivery(igComment({ from: { id: IG, username: "a_made_up_shop" } })));
    expect(own).toMatchObject({ own: true });
  });

  it("leaves out live comments, mentions, and comments it can't place", () => {
    expect(parseMetaPayload(igDelivery(igComment(), "live_comments"), NOW)).toEqual([]);
    expect(
      parseMetaPayload(igDelivery({ media_id: MEDIA, comment_id: "1" }, "mentions"), NOW),
    ).toEqual([]);
    expect(parseMetaPayload(igDelivery(igComment({ text: "" })), NOW)).toEqual([]);
    expect(parseMetaPayload(igDelivery(igComment({ media: {} })), NOW)).toEqual([]);
    expect(parseMetaPayload(igDelivery(igComment({ from: {} })), NOW)).toEqual([]);
    // A username that isn't one is never kept as a handle.
    expect(
      only(igDelivery(igComment({ from: { id: PERSON, username: "not a/handle" } }))),
    ).toMatchObject({ handle: null });
  });

  it("reads comments and messages out of one delivery, in order", () => {
    const events = parseMetaPayload(
      {
        object: "instagram",
        entry: [
          {
            id: IG,
            time: Math.floor(NOW / 1000),
            changes: [{ field: "comments", value: igComment() }],
            messaging: [
              {
                sender: { id: PERSON },
                recipient: { id: IG },
                timestamp: NOW - 1000,
                message: { mid: "m_made_up", text: "Hello" },
              },
            ],
          },
        ],
      },
      NOW,
    );
    expect(events.map((event) => event.type)).toEqual(["comment", "message"]);
  });
});

describe("which comments are worth a conversation", () => {
  it("knows noise when it sees it (ported from the owner's help desk)", () => {
    for (const text of [
      "🔥",
      "🔥🔥🔥",
      "😍😍",
      "❤️",
      "",
      "ok",
      "@a_friend 😍",
      "@a_friend look!",
      "@a_friend we need this",
      "love it",
      "Love this!!",
      "wow",
      "so cute 😍",
      "Gorgeous ✨",
      "need this",
      "great work!",
      "OMG",
      "yesss",
    ]) {
      expect(isNoise(text), text).toBe(true);
    }
    for (const text of [
      "Do you ship to Canada?",
      "How much is the large one",
      "@a_friend do they do classes?",
      "Mine arrived broken",
      "love it, where can I buy the frame",
      "What yarn is that",
    ]) {
      expect(isNoise(text), text).toBe(false);
    }
  });

  const settings = (over: Partial<ChannelSettings> = {}) => ({
    comment_filter: "skip_noise" as const,
    comment_words: [] as string[],
    ...over,
  });
  const says = (text: string, hasMedia = false) => ({ text, hasMedia });

  it("by default keeps real comments and skips emoji, tags and cheers", () => {
    expect(startsConversation(says("Do you ship to Canada?"), settings())).toBe(true);
    expect(startsConversation(says("Mine arrived broken"), settings())).toBe(true);
    expect(startsConversation(says("🔥"), settings())).toBe(false);
    expect(startsConversation(says("@a_friend 😍"), settings())).toBe(false);
    expect(startsConversation(says("love it"), settings())).toBe(false);
    // A picture is something to look at, whatever the words.
    expect(startsConversation(says("", true), settings())).toBe(true);
    expect(startsConversation(says("", false), settings())).toBe(false);
  });

  it("keeps everything when the workspace says so, and only matches when it says that", () => {
    expect(startsConversation(says("🔥"), settings({ comment_filter: "all" }))).toBe(true);
    expect(startsConversation(says("  "), settings({ comment_filter: "all" }))).toBe(false);
    const matching = settings({ comment_filter: "matching", comment_words: ["refund", "class"] });
    expect(startsConversation(says("Is it wool?"), matching)).toBe(true);
    expect(startsConversation(says("I want a refund"), matching)).toBe(true);
    expect(startsConversation(says("Mine arrived broken"), matching)).toBe(false);
    expect(startsConversation(says("", true), matching)).toBe(false);
  });

  it("a workspace's own words always count, as whole words in any case", () => {
    const words = ["order", "class"];
    expect(hasOwnWord("Where is my ORDER", words)).toBe(true);
    expect(hasOwnWord("my order, please", words)).toBe(true);
    expect(hasOwnWord("what a classic", words)).toBe(false);
    expect(hasOwnWord("border collie", words)).toBe(false);
    expect(hasOwnWord("anything", [])).toBe(false);
    expect(hasOwnWord("anything", [" ", "a"])).toBe(false);
    // "need this order" would be a cheer but for the workspace's word.
    expect(startsConversation(says("class 😍"), settings({ comment_words: words }))).toBe(true);
  });

  it("the settings default to comments off and noise skipped, and refuse a long word list", () => {
    const parsed = parseChannelSettings({ version: 1, instagram: true });
    expect(parsed).toMatchObject({
      instagram: true,
      instagram_comments: false,
      facebook_comments: false,
      comment_filter: "skip_noise",
      comment_words: [],
    });
    expect(
      channelSettingsSchema.safeParse({ version: 1, comment_words: Array(31).fill("word") })
        .success,
    ).toBe(false);
    expect(channelSettingsSchema.safeParse({ version: 1, comment_filter: "some" }).success).toBe(
      false,
    );
  });

  it("names a conversation by what it is", () => {
    expect(commentSubject("instagram", "Is this back in stock?\nAsking for a friend", null)).toBe(
      "Instagram comment: Is this back in stock?",
    );
    expect(commentSubject("facebook", "", "Posted a photo")).toBe(
      "Facebook comment: Posted a photo",
    );
    expect(commentSubject("facebook", "x".repeat(90), null)).toBe(
      `Facebook comment: ${"x".repeat(67)}…`,
    );
    expect(conversationWords("instagram", "comment")).toBe("Instagram comment");
    expect(conversationWords("facebook", "message")).toBe("Facebook message");
    expect(conversationWords("facebook", null)).toBe("Facebook message");
  });
});

describe("the post a comment is on", () => {
  it("keeps an address only when it is on the platform itself", () => {
    expect(postLink("instagram", "https://www.instagram.com/p/MADEUP123/")).toBe(
      "https://www.instagram.com/p/MADEUP123/",
    );
    expect(postLink("facebook", "https://www.facebook.com/1000000000000001/posts/5")).toBe(
      "https://www.facebook.com/1000000000000001/posts/5",
    );
    for (const bad of [
      "http://www.instagram.com/p/x/",
      "https://instagram.com.evil.example/p/x/",
      "https://evil.example/www.instagram.com/",
      "https://user:pass@www.instagram.com/p/x/",
      "https://www.instagram.com:8443/p/x/",
      "javascript:alert(1)",
      "not a url",
      null,
      42,
    ]) {
      expect(postLink("instagram", bad), String(bad)).toBeNull();
    }
    // One platform's address is not the other's.
    expect(postLink("facebook", "https://www.instagram.com/p/x/")).toBeNull();
  });

  it("keeps the start of the caption as one plain line", () => {
    expect(postExcerpt("  New   colours\n\nthis week ")).toBe("New colours this week");
    const long = postExcerpt("word ".repeat(200));
    expect([...long]).toHaveLength(POST_EXCERPT_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(postExcerpt(undefined)).toBe("");
    expect(postExcerpt(12)).toBe("");
  });
});

describe("one private message per comment", () => {
  const at = new Date(NOW - 3600_000).toISOString();
  const format = () => "Wed 3:00 PM";

  it("is there for a fresh comment, and says until when", () => {
    const state = privateReplyState({ at, privateReply: null }, NOW, true);
    expect(state).toEqual({
      state: "available",
      until: new Date(NOW - 3600_000 + PRIVATE_REPLY_WINDOW_MS).toISOString(),
    });
    expect(privateReplyWords("instagram", "available", state.until, format)).toContain(
      "one private message about a comment, until Wed 3:00 PM",
    );
  });

  it("is gone once used, and says why", () => {
    expect(privateReplyState({ at, privateReply: "sent" }, NOW, true).state).toBe("used");
    expect(privateReplyWords("facebook", "used", null, format)).toContain(
      "You've sent your one private message about this comment",
    );
    // One on its way counts as taken: it is never sent twice.
    expect(privateReplyState({ at, privateReply: "claimed" }, NOW, true).state).toBe("sending");
  });

  it("is gone after seven days, a little early rather than racing Meta's clock", () => {
    const old = (ms: number) =>
      privateReplyState({ at: new Date(NOW - ms).toISOString(), privateReply: null }, NOW, true)
        .state;
    expect(old(PRIVATE_REPLY_WINDOW_MS - 10 * 60_000)).toBe("available");
    expect(old(PRIVATE_REPLY_WINDOW_MS - 60_000)).toBe("expired");
    expect(old(PRIVATE_REPLY_WINDOW_MS + 1)).toBe("expired");
    expect(privateReplyWords("instagram", "expired", null, format)).toContain("seven days");
  });

  it("needs the messaging permission, and a comment to answer", () => {
    expect(privateReplyState({ at, privateReply: null }, NOW, false).state).toBe("not_allowed");
    expect(privateReplyState(null, NOW, true).state).toBe("none");
    // Used wins over everything: the reason shown is the true one.
    expect(privateReplyState({ at, privateReply: "sent" }, NOW, false).state).toBe("used");
  });

  it("answers the customer's latest comment that still stands", () => {
    const row = (id: string, minutes: number, over: Record<string, unknown> = {}) => ({
      id,
      direction: "inbound",
      kind: "comment",
      removed_at: null as string | null,
      sent_at: new Date(NOW - minutes * 60_000).toISOString(),
      created_at: new Date(NOW).toISOString(),
      ...over,
    });
    const thread = [
      row("first", 30),
      row("ours", 20, { direction: "outbound" }),
      row("second", 10),
      row("gone", 5, { removed_at: new Date(NOW).toISOString() }),
      row("private", 2, { direction: "outbound", kind: "private_reply" }),
    ];
    expect(latestComment(thread)?.id).toBe("second");
    expect(latestComment([row("ours", 1, { direction: "outbound" })])).toBeNull();
  });
});

describe("where comments stand", () => {
  const connection = (scopes: string[], over: Partial<MetaConnectionFacts> = {}) => ({
    status: "active",
    scopes,
    pageName: "A Made Up Page",
    instagramId: IG,
    instagramUsername: "a_made_up_shop",
    ...over,
  });
  const on = parseChannelSettings({
    version: 1,
    facebook_comments: true,
    instagram_comments: true,
  });

  it("needs each platform's own permissions", () => {
    const fb = scopesFor(["facebook_comments"]);
    const ig = scopesFor(["instagram_comments"]);
    expect(commentScopesAllow("facebook", fb)).toBe(true);
    expect(commentScopesAllow("instagram", fb)).toBe(false);
    expect(commentScopesAllow("instagram", ig)).toBe(true);
    expect(commentScopesAllow("facebook", ig)).toBe(false);
    expect(commentScopesAllow("facebook", scopesFor(["messages", "posting"]))).toBe(false);
    expect(commentScopesAllow("facebook", null)).toBe(false);
  });

  it("is off until switched on, and blocked with a reason when the connection can't carry it", () => {
    const fb = scopesFor(["facebook_comments"]);
    expect(
      commentState("facebook", parseChannelSettings({ version: 1 }), connection(fb)).state,
    ).toBe("off");
    expect(commentState("facebook", on, connection(fb))).toEqual({ state: "on", why: null });
    expect(commentState("instagram", on, connection(fb)).state).toBe("blocked");
    expect(commentState("facebook", on, null).state).toBe("blocked");
    expect(
      commentState("facebook", on, connection(fb, { status: "needs_reconnect" })).why,
    ).toContain("reconnecting");
    expect(
      commentState(
        "instagram",
        on,
        connection(scopesFor(["instagram_comments"]), { instagramId: null }),
      ).why,
    ).toContain("No Instagram professional account");
  });

  it("knows what the team may do with a comment", () => {
    expect(commentAbilities("facebook", scopesFor(["facebook_comments"]))).toEqual({
      reply: true,
      moderate: true,
      privately: false,
    });
    expect(
      commentAbilities("facebook", scopesFor(["facebook_comments", "messages"])).privately,
    ).toBe(true);
    // Reading comments without the permission to manage them: look, don't touch.
    expect(
      commentAbilities("facebook", ["pages_manage_metadata", "pages_read_user_content"]).reply,
    ).toBe(false);
    expect(commentAbilities("instagram", ["pages_messaging"]).privately).toBe(false);
  });

  it("asks a Page for its feed only when comments are wanted", () => {
    expect(subscribedFieldsFor({ messages: true, comments: false })).toEqual([
      "messages",
      "message_echoes",
      "message_reactions",
      "standby",
      "messaging_handovers",
    ]);
    expect(subscribedFieldsFor({ messages: false, comments: true })).toEqual(["feed"]);
    expect(subscribedFieldsFor({ messages: true, comments: true })).toContain("feed");
    expect(subscribedFieldsFor({ messages: false, comments: false })).toEqual([]);
  });
});

describe("a delivery of comments becomes conversations", () => {
  function deps(over: Partial<IntakeDeps> = {}, filter: Partial<ChannelSettings> = {}) {
    const calls: string[] = [];
    const seen = new Set<string>();
    const base: IntakeDeps = {
      now: () => NOW,
      ourAppId: "555",
      whereFor: async () => null,
      rulesFor: async () =>
        ({
          version: 1,
          rules: [{ id: "r", where: "any", contains: "refund", tag: "refunds" }],
        }) as never,
      file: async () => ({ result: "created" }),
      echo: async () => ({ result: "threaded" }),
      remove: async () => undefined,
      react: async () => undefined,
      commentsFor: async (channel, account) =>
        account === PAGE || account === IG
          ? { tenantId: "t1", pageId: PAGE, channel, ownHandle: "a_made_up_shop" }
          : null,
      commentFilterFor: async () => ({
        comment_filter: "skip_noise",
        comment_words: [],
        ...filter,
      }),
      fileComment: async (_where, event, subject, tags, start) => {
        calls.push(`file ${event.commentId} "${subject}" [${tags.join(",")}] start=${start}`);
        if (seen.has(event.commentId)) return { result: "duplicate", message_id: "m1" };
        if (!start) return { result: "filtered" };
        seen.add(event.commentId);
        return {
          result: "created",
          ticket_id: "k1",
          message_id: "m1",
          contact_id: "c1",
          number: 12,
          post_id: "post-row",
          needs_post: true,
        } satisfies CommentFiled;
      },
      ownComment: async (_where, event) => {
        calls.push(`own ${event.commentId} under ${event.parentId}`);
        return { result: event.commentId === "busy" ? "retry" : "threaded" };
      },
      editComment: async (_where, event) => {
        calls.push(`edit ${event.commentId}`);
        return event.commentId === "held";
      },
      removeComment: async (_where, id) => void calls.push(`remove ${id}`),
      hideComment: async (_where, id, hidden) =>
        void calls.push(`${hidden ? "hide" : "show"} ${id}`),
      refreshPost: async (_where, event, postId) =>
        void calls.push(`post ${event.postId} -> ${postId}`),
      fetchCommentFiles: async (event) => {
        calls.push(`fetch ${event.media.length}`);
        return [];
      },
      keepFiles: async () => void calls.push("keep"),
      onCommentCreated: async (_where, event, result) =>
        void calls.push(`created #${result.number} from ${event.handle ?? event.name}`),
      ...over,
    };
    return { deps: base, calls };
  }

  it("files a comment, reads the post once, and says who it is from", async () => {
    const { deps: d, calls } = deps();
    expect(await processMetaPayload(igDelivery(igComment()), d)).toEqual(["comment created"]);
    expect(calls).toEqual([
      'file 17900000000000111 "Instagram comment: Is this back in stock?" [] start=true',
      `post ${MEDIA} -> post-row`,
      "created #12 from a_made_up_person",
    ]);
  });

  it("applies the workspace's auto-tag rules", async () => {
    const { deps: d, calls } = deps();
    await processMetaPayload(feed(fbComment({ message: "I'd like a refund please" })), d);
    expect(calls[0]).toContain("[refunds] start=true");
  });

  it("is idempotent: the same comment delivered twice is filed once", async () => {
    const { deps: d, calls } = deps();
    expect(await processMetaPayload(igDelivery(igComment()), d)).toEqual(["comment created"]);
    expect(await processMetaPayload(igDelivery(igComment()), d)).toEqual(["comment duplicate"]);
    expect(calls.filter((call) => call.startsWith("created"))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("post"))).toHaveLength(1);
  });

  it("doesn't start a conversation for noise, by the workspace's setting", async () => {
    const noisy = deps();
    expect(await processMetaPayload(igDelivery(igComment({ text: "🔥🔥" })), noisy.deps)).toEqual([
      "comment not kept",
    ]);
    expect(noisy.calls).toEqual([
      'file 17900000000000111 "Instagram comment: 🔥🔥" [] start=false',
    ]);

    const all = deps({}, { comment_filter: "all" });
    expect(await processMetaPayload(igDelivery(igComment({ text: "🔥🔥" })), all.deps)).toEqual([
      "comment created",
    ]);
  });

  it("drops comments for an account that doesn't take them, without reading further", async () => {
    const { deps: d, calls } = deps();
    expect(await processMetaPayload(feed(fbComment(), "someone-elses-page"), d)).toEqual([
      "dropped",
    ]);
    expect(calls).toEqual([]);
    // Messages being on is not comments being on.
    const messagesOnly = deps({ commentsFor: undefined });
    expect(await processMetaPayload(feed(fbComment()), messagesOnly.deps)).toEqual(["dropped"]);
  });

  it("files the team's own reply under the comment it answers, and never as a customer's", async () => {
    const { deps: d, calls } = deps();
    const own = fbComment({
      comment_id: "reply-1",
      parent_id: `${POST}_700`,
      from: { id: PAGE, name: "A Made Up Page" },
      message: "Yes we do!",
    });
    expect(await processMetaPayload(feed(own), d)).toEqual(["own comment threaded"]);
    expect(calls).toEqual([`own reply-1 under ${POST}_700`]);

    // On Instagram the account is known by its username too.
    const ig = deps();
    const mine = igComment({
      id: "reply-2",
      parent_id: "17900000000000111",
      from: { id: "an-id-meta-uses-for-us", username: "A_Made_Up_Shop" },
    });
    expect(await processMetaPayload(igDelivery(mine), ig.deps)).toEqual(["own comment threaded"]);
    // The account's own top-level comment on its own post answers nobody.
    const top = igComment({ id: "top", from: { id: IG, username: "a_made_up_shop" } });
    expect(await processMetaPayload(igDelivery(top), ig.deps)).toEqual(["own comment ignored"]);
  });

  it("comes back later while the help desk's own reply is still being written down", async () => {
    const { deps: d } = deps();
    const busy = fbComment({ comment_id: "busy", parent_id: "c1", from: { id: PAGE } });
    await expect(processMetaPayload(feed(busy), d)).rejects.toBeInstanceOf(RetryLater);
  });

  it("an edit changes a comment we hold; one we never held is looked at afresh", async () => {
    const { deps: d, calls } = deps();
    expect(
      await processMetaPayload(feed(fbComment({ verb: "edited", comment_id: "held" })), d),
    ).toEqual(["comment edited"]);
    expect(calls).toEqual(["edit held"]);

    const fresh = deps();
    expect(
      await processMetaPayload(
        feed(fbComment({ verb: "edited", comment_id: "new", message: "Actually, do you ship?" })),
        fresh.deps,
      ),
    ).toEqual(["comment created"]);
    expect(fresh.calls[0]).toBe("edit new");
    expect(fresh.calls[1]).toContain("file new");
  });

  it("passes on removals and hides", async () => {
    const { deps: d, calls } = deps();
    expect(await processMetaPayload(feed(fbComment({ verb: "remove" })), d)).toEqual([
      "comment removed",
    ]);
    expect(await processMetaPayload(feed(fbComment({ verb: "hide" })), d)).toEqual([
      "comment hidden",
    ]);
    expect(await processMetaPayload(feed(fbComment({ verb: "unhide" })), d)).toEqual([
      "comment shown",
    ]);
    expect(calls).toEqual([`remove ${POST}_700`, `hide ${POST}_700`, `show ${POST}_700`]);
  });

  it("fetches a Facebook comment's picture, and never loses the comment over the post", async () => {
    const { deps: d, calls } = deps({
      refreshPost: async () => {
        throw new Error("Meta is having a moment");
      },
    });
    const withPhoto = fbComment({ photo: "https://scontent.xx.fbcdn.net/v/made-up.jpg" });
    expect(await processMetaPayload(feed(withPhoto), d)).toEqual(["comment created"]);
    expect(calls).toContain("fetch 1");
    expect(calls).toContain("keep");
  });
});

describe("answering through Meta", () => {
  const token = randomBytes(24).toString("hex");
  type Call = { url: string; init: RequestInit };
  const fakeMeta = (answers: (Response | Error)[]) => {
    const calls: Call[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = answers.shift();
      if (!next || next instanceof Error) throw next ?? new Error("no answer set");
      return next;
    }) as unknown as typeof fetch;
    return { impl, calls };
  };
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const no = (code: number, message: string, status = 400) =>
    new Response(JSON.stringify({ error: { message, code } }), { status });
  const path = (call: Call) => call.url.replace(/^https:\/\/graph\.facebook\.com\/v[0-9.]+/, "");
  const auth = (call: Call) => (call.init.headers as Record<string, string>).Authorization;

  it("replies publicly under a Facebook comment and under an Instagram one", async () => {
    const fb = fakeMeta([ok({ id: "new-comment-1" })]);
    expect(await replyToComment("facebook", token, "c-1", "Yes we do!", fb.impl)).toBe(
      "new-comment-1",
    );
    expect(path(fb.calls[0])).toBe("/c-1/comments");
    expect(fb.calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(fb.calls[0].init.body))).toEqual({ message: "Yes we do!" });
    // The token rides in the header, never in the address.
    expect(fb.calls[0].url).not.toContain(token);
    expect(auth(fb.calls[0])).toBe(`Bearer ${token}`);

    const ig = fakeMeta([ok({ id: "new-comment-2" })]);
    expect(await replyToComment("instagram", token, "c-2", "Back on Friday", ig.impl)).toBe(
      "new-comment-2",
    );
    expect(path(ig.calls[0])).toBe("/c-2/replies");
  });

  it("a refusal is a refusal; no clear answer is never taken as either", async () => {
    const refused = fakeMeta([no(200, "Permissions error")]);
    await expect(replyToComment("facebook", token, "c", "Hi", refused.impl)).rejects.toMatchObject({
      name: "MetaRefused",
      code: 200,
    });
    const silent = fakeMeta([new Error("socket hang up")]);
    await expect(replyToComment("facebook", token, "c", "Hi", silent.impl)).rejects.toBeInstanceOf(
      MetaUnsure,
    );
    const odd = fakeMeta([ok({})]);
    await expect(replyToComment("facebook", token, "c", "Hi", odd.impl)).rejects.toBeInstanceOf(
      MetaUnsure,
    );
  });

  it("sends the one private message with the comment as the recipient", async () => {
    const { impl, calls } = fakeMeta([ok({ recipient_id: PERSON, message_id: "m_private" })]);
    expect(
      await sendPrivateReply({ pageId: PAGE, token }, "c-1", "Sent you the details", impl),
    ).toEqual({ messageId: "m_private", recipientId: PERSON });
    expect(path(calls[0])).toBe(`/${PAGE}/messages`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      recipient: { comment_id: "c-1" },
      message: { text: "Sent you the details" },
    });
    expect(calls[0].url).not.toContain(token);
  });

  it("hides and shows a comment the way each platform asks", async () => {
    const fb = fakeMeta([ok({ success: true }), ok({ success: true })]);
    await setCommentHidden("facebook", token, "c-1", true, fb.impl);
    await setCommentHidden("facebook", token, "c-1", false, fb.impl);
    expect(path(fb.calls[0])).toBe("/c-1");
    expect(JSON.parse(String(fb.calls[0].init.body))).toEqual({ is_hidden: true });
    expect(JSON.parse(String(fb.calls[1].init.body))).toEqual({ is_hidden: false });

    const ig = fakeMeta([ok({ success: true })]);
    await setCommentHidden("instagram", token, "c-2", true, ig.impl);
    expect(path(ig.calls[0])).toBe("/c-2?hide=true");
    expect(ig.calls[0].init.method).toBe("POST");

    const refused = fakeMeta([no(100, "Unsupported post request")]);
    await expect(
      setCommentHidden("instagram", token, "c-2", true, refused.impl),
    ).rejects.toBeInstanceOf(MetaRefused);
    // "It worked" must be said in so many words.
    const vague = fakeMeta([ok({ success: false })]);
    await expect(setCommentHidden("facebook", token, "c", true, vague.impl)).rejects.toBeInstanceOf(
      MetaUnsure,
    );
  });

  it("deletes a comment", async () => {
    const { impl, calls } = fakeMeta([ok({ success: true })]);
    await deleteComment(token, "c-9", impl);
    expect(path(calls[0])).toBe("/c-9");
    expect(calls[0].init.method).toBe("DELETE");
    expect(auth(calls[0])).toBe(`Bearer ${token}`);
  });

  it("reads a post's address and caption, and asks for nothing else", async () => {
    const fb = fakeMeta([
      ok({
        message: "New colours this week",
        permalink_url: "https://www.facebook.com/1/posts/2",
        id: POST,
      }),
    ]);
    expect(await readPost("facebook", token, POST, fb.impl)).toEqual({
      permalink: "https://www.facebook.com/1/posts/2",
      caption: "New colours this week",
    });
    expect(new URL(fb.calls[0].url).searchParams.get("fields")).toBe("message,permalink_url");

    const ig = fakeMeta([ok({ caption: "Made up", permalink: "https://www.instagram.com/p/X/" })]);
    expect(await readPost("instagram", token, MEDIA, ig.impl)).toEqual({
      permalink: "https://www.instagram.com/p/X/",
      caption: "Made up",
    });
    expect(new URL(ig.calls[0].url).searchParams.get("fields")).toBe("caption,permalink");
    // No picture, no video, no likes: the fields asked for are the whole list.
    for (const call of [...fb.calls, ...ig.calls]) {
      expect(call.url).not.toMatch(/media_url|full_picture|thumbnail|attachments/);
    }
  });

  describe("a whole answer", () => {
    const where = { tenantId: "t1", ticketId: "k1" };
    const payload = (via: "public" | "private", text = "Yes we do!", comment = "c-1") =>
      socialPayloadSchema.parse({
        kind: "social",
        channel: "instagram",
        doc: textToRich(text),
        then: "pending",
        via,
        comment_id: comment,
      });
    const tokenDeps: TokenDeps = {
      store: {
        read: async () => ({
          connectionId: "conn",
          externalAccountId: PAGE,
          status: "active",
          token: { access_token: token },
        }),
        lockRefresh: async () => false,
        save: async () => undefined,
        markNeedsReconnect: async () => undefined,
      },
      adapter: () => {
        throw new Error("not needed");
      },
      now: () => NOW,
      wait: async () => undefined,
    };
    const facts = (scopes: string[], settings: Partial<ChannelSettings> = {}): ChannelFacts => ({
      settings: parseChannelSettings({
        version: 1,
        instagram_comments: true,
        facebook_comments: true,
        ...settings,
      }),
      connection: {
        status: "active",
        scopes,
        pageName: "A Made Up Page",
        instagramId: IG,
        instagramUsername: "a_made_up_shop",
      },
    });
    const ALL = scopesFor(["messages", "facebook_comments", "instagram_comments"]);
    /** A stand-in for the database: one comment, and the claim on its private message. */
    function fakeAdmin(over: Record<string, unknown> = {}) {
      const comment = {
        channel: "instagram",
        external_id: PERSON,
        label: "@a_made_up_person",
        comment_id: "c-1",
        comment_message_id: "row-1",
        comment_at: new Date(NOW - 3600_000).toISOString(),
        comment_hidden: false,
        private_reply: null as string | null,
        ...over,
      };
      const rpcs: string[] = [];
      const admin = {
        rpc: async (name: string) => {
          rpcs.push(name);
          if (name === "comment_reply_context") return { data: [comment], error: null };
          if (name === "claim_private_reply") {
            const free = comment.private_reply === null;
            if (free) comment.private_reply = "claimed";
            return { data: free, error: null };
          }
          if (name === "release_private_reply") {
            if (comment.private_reply === "claimed") comment.private_reply = null;
            return { data: null, error: null };
          }
          return { data: null, error: { message: `unexpected ${name}` } };
        },
      } as unknown as SupabaseClient;
      return { admin, rpcs, comment };
    }
    const run = (
      via: "public" | "private",
      db: ReturnType<typeof fakeAdmin>,
      meta: ReturnType<typeof fakeMeta>,
      scopes = ALL,
      settings: Partial<ChannelSettings> = {},
      text?: string,
    ) =>
      sendCommentReply(where, payload(via, text), {
        admin: db.admin,
        tokenDeps,
        fetchImpl: meta.impl,
        now: () => NOW,
        facts: async () => facts(scopes, settings),
      });

    it("sends a public reply under the comment and hands back Meta's id for it", async () => {
      const db = fakeAdmin();
      const meta = fakeMeta([ok({ id: "new-comment" })]);
      expect(await run("public", db, meta)).toEqual({
        externalId: "new-comment",
        via: "public",
        channel: "instagram",
      });
      expect(path(meta.calls[0])).toBe("/c-1/replies");
      // A public reply never touches the private message's claim.
      expect(db.rpcs).toEqual(["comment_reply_context"]);
    });

    it("sends the private message once: the second try is stopped before Meta is asked", async () => {
      const db = fakeAdmin();
      const meta = fakeMeta([ok({ recipient_id: PERSON, message_id: "m_1" })]);
      expect(await run("private", db, meta)).toMatchObject({ externalId: "m_1", via: "private" });
      expect(db.comment.private_reply).toBe("claimed");

      const again = fakeMeta([ok({ recipient_id: PERSON, message_id: "m_2" })]);
      await expect(run("private", db, again)).rejects.toMatchObject({ code: "private_used" });
      expect(again.calls).toHaveLength(0);
      // Once it is written down as sent, the same.
      db.comment.private_reply = "sent";
      await expect(run("private", db, again)).rejects.toMatchObject({ code: "private_used" });
      expect(again.calls).toHaveLength(0);
    });

    it("two sends at once: one gets the claim, the other is told it is used", async () => {
      const db = fakeAdmin();
      const meta = fakeMeta([
        ok({ recipient_id: PERSON, message_id: "m_1" }),
        ok({ recipient_id: PERSON, message_id: "m_2" }),
      ]);
      const results = await Promise.allSettled([
        run("private", db, meta),
        run("private", db, meta),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(meta.calls).toHaveLength(1);
    });

    it("gives the claim back when Meta refuses, and keeps it when Meta doesn't answer", async () => {
      const refused = fakeAdmin();
      await expect(
        run("private", refused, fakeMeta([no(10, "This person isn't available right now")])),
      ).rejects.toBeInstanceOf(MetaRefused);
      expect(refused.comment.private_reply).toBeNull();
      expect(refused.rpcs).toContain("release_private_reply");

      const silent = fakeAdmin();
      await expect(
        run("private", silent, fakeMeta([new Error("timed out")])),
      ).rejects.toBeInstanceOf(MetaUnsure);
      // It may have gone: it is never sent a second time.
      expect(silent.comment.private_reply).toBe("claimed");
      expect(silent.rpcs).not.toContain("release_private_reply");
    });

    it("stops a private message after seven days, or without permission to message", async () => {
      const old = fakeAdmin({ comment_at: new Date(NOW - 8 * 24 * 3600_000).toISOString() });
      const meta = fakeMeta([]);
      await expect(run("private", old, meta)).rejects.toMatchObject({ code: "private_expired" });
      await expect(
        run("private", fakeAdmin(), meta, scopesFor(["instagram_comments"])),
      ).rejects.toMatchObject({ code: "not_allowed" });
      expect(meta.calls).toHaveLength(0);
    });

    it("never answers under a different comment than the one it was written for", async () => {
      const db = fakeAdmin({ comment_id: "c-2" });
      const meta = fakeMeta([]);
      await expect(run("public", db, meta)).rejects.toMatchObject({ code: "comment_changed" });
      await expect(run("public", fakeAdmin({ comment_id: null }), meta)).rejects.toMatchObject({
        code: "no_comment",
      });
      expect(meta.calls).toHaveLength(0);
    });

    it("stops when comments are off, the permission is missing, the comment is hidden or the words too long", async () => {
      const meta = fakeMeta([]);
      await expect(
        run("public", fakeAdmin(), meta, ALL, { instagram_comments: false }),
      ).rejects.toMatchObject({ code: "comments_off" });
      await expect(run("public", fakeAdmin(), meta, scopesFor(["messages"]))).rejects.toMatchObject(
        { code: "comments_off" },
      );
      await expect(run("public", fakeAdmin({ comment_hidden: true }), meta)).rejects.toMatchObject({
        code: "comment_hidden",
      });
      await expect(
        run("public", fakeAdmin(), meta, ALL, {}, "x".repeat(COMMENT_LIMITS.instagram.max + 1)),
      ).rejects.toMatchObject({ code: "too_long" });
      // A private message is a message: it holds what one Instagram message holds.
      await expect(
        run("private", fakeAdmin(), meta, ALL, {}, "x".repeat(1001)),
      ).rejects.toMatchObject({ code: "too_long" });
      expect(meta.calls).toHaveLength(0);
      for (const err of ["comments_off", "comment_hidden", "private_used", "comment_changed"]) {
        expect(refusalWords(new SocialNotSent(err as never).code)).not.toContain(
          "Meta didn't take it",
        );
      }
    });

    it("a message conversation's payload is never sent as a comment", async () => {
      const plain = socialPayloadSchema.parse({
        kind: "social",
        channel: "instagram",
        doc: textToRich("Hi"),
        then: "pending",
      });
      expect(plain).toMatchObject({ via: "message", comment_id: null });
      await expect(
        sendCommentReply(where, plain, { admin: fakeAdmin().admin, tokenDeps }),
      ).rejects.toMatchObject({ code: "no_conversation" });
    });
  });

  it("explains Meta's own refusal of a second private message", () => {
    const stored = "meta:10900:x:none:Activity already replied to";
    expect(refusalWords(stored)).toContain("already had its one private message");
  });
});
