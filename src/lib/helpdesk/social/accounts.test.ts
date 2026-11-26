import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { accountsOffered, pageTokenKey, sharedPages } from "../../connections/providers/meta";
import { pageTokenOf } from "../../connections/meta-token";
import type { StoredToken, TokenDeps } from "../../connections/tokens";
import { textToRich } from "../rich";
import { parseChannelSettings } from "./channels";
import { socialPayloadSchema } from "./deliver";
import { SocialNotSent, sendCommentReply, sendSocialReply, type ChannelFacts } from "./server";

/**
 * Several Pages on one login: a conversation is answered as the account the
 * customer wrote to, through that account's own Page and its own token.
 * Everything here is made up; nothing is sent to Meta.
 */

const NOW = Date.parse("2026-11-25T15:00:00Z");
const FIRST_PAGE = "1000000000000001";
const SECOND_PAGE = "1000000000000002";
const SECOND_IG = "1784000000000022";
const PERSON = "9000000000000003";
const firstToken = randomBytes(16).toString("hex");
const secondToken = randomBytes(16).toString("hex");

const stored: StoredToken = {
  connectionId: "conn",
  externalAccountId: FIRST_PAGE,
  status: "active",
  token: {
    access_token: firstToken,
    secrets: { [pageTokenKey(FIRST_PAGE)]: firstToken, [pageTokenKey(SECOND_PAGE)]: secondToken },
  },
};
const tokenDeps: TokenDeps = {
  store: {
    read: async () => stored,
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
const facts = (): ChannelFacts => ({
  settings: parseChannelSettings({
    version: 1,
    instagram: true,
    facebook: true,
    instagram_comments: true,
  }),
  connection: {
    status: "active",
    scopes: [
      "pages_manage_metadata",
      "pages_read_engagement",
      "pages_messaging",
      "instagram_basic",
      "instagram_manage_messages",
      "instagram_manage_comments",
    ],
    pageName: "First Page",
    instagramId: SECOND_IG,
    instagramUsername: "second_made_up",
  },
});

type Call = { url: string; init: RequestInit };
const fakeMeta = (answers: Response[]) => {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answers.shift() ?? new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
  return { impl, calls };
};
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const path = (call: Call) => new URL(call.url).pathname.replace(/^\/v[0-9.]+/, "");
const auth = (call: Call) => new Headers(call.init.headers).get("Authorization");

function fakeAdmin(account: Record<string, unknown> | null, kind: "message" | "comment") {
  const admin = {
    rpc: async (name: string) => {
      if (name === "social_reply_context") {
        return {
          data: [
            {
              channel: "instagram",
              external_id: PERSON,
              label: "@someone",
              last_inbound_at: new Date(NOW - 60_000).toISOString(),
            },
          ],
          error: null,
        };
      }
      if (name === "comment_reply_context" && kind === "comment") {
        return {
          data: [
            {
              channel: "instagram",
              external_id: PERSON,
              label: "@someone",
              comment_id: "c-9",
              comment_message_id: "m-9",
              comment_at: new Date(NOW - 60_000).toISOString(),
              comment_hidden: false,
              private_reply: null,
            },
          ],
          error: null,
        };
      }
      if (name === "social_ticket_account") return { data: account ? [account] : [], error: null };
      if (name === "note_thread_control") return { data: true, error: null };
      return { data: null, error: { message: `unexpected ${name}` } };
    },
    storage: { from: () => ({}) },
  } as unknown as SupabaseClient;
  return admin;
}

const secondAccount = {
  social_account_id: "acct-2",
  network: "instagram",
  platform_id: SECOND_IG,
  page_id: SECOND_PAGE,
  tasks: ["MANAGE"],
  active: true,
};
const where = { tenantId: "t-1", ticketId: "ticket-1" };
const message = socialPayloadSchema.parse({
  kind: "social",
  channel: "instagram",
  via: "message",
  doc: textToRich("Thanks for asking!"),
  then: "pending",
  files: [],
});

describe("answering as the account the customer wrote to", () => {
  it("a reply goes through that account's own Page, with that Page's token", async () => {
    const meta = fakeMeta([ok({ message_id: "out-1" })]);
    const went = await sendSocialReply(where, message, {
      admin: fakeAdmin(secondAccount, "message"),
      tokenDeps,
      fetchImpl: meta.impl,
      now: () => NOW,
      facts: async () => facts(),
    });
    expect(went.mids).toEqual(["out-1"]);
    expect(path(meta.calls[0])).toBe(`/${SECOND_PAGE}/messages`);
    expect(auth(meta.calls[0])).toBe(`Bearer ${secondToken}`);
  });

  it("an account out of use, or whose Page doesn't allow messaging, sends nothing", async () => {
    for (const account of [
      { ...secondAccount, active: false },
      { ...secondAccount, tasks: ["CREATE_CONTENT"] },
    ]) {
      const meta = fakeMeta([ok({ message_id: "never" })]);
      const err = await sendSocialReply(where, message, {
        admin: fakeAdmin(account, "message"),
        tokenDeps,
        fetchImpl: meta.impl,
        now: () => NOW,
        facts: async () => facts(),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SocialNotSent);
      expect(meta.calls).toHaveLength(0);
    }
  });

  it("a public comment reply is made with the comment's account's Page token", async () => {
    const meta = fakeMeta([ok({ id: "reply-1" })]);
    const payload = socialPayloadSchema.parse({
      kind: "social",
      channel: "instagram",
      via: "public",
      comment_id: "c-9",
      doc: textToRich("It's on the shop page"),
      then: "pending",
      files: [],
    });
    const went = await sendCommentReply(where, payload, {
      admin: fakeAdmin(secondAccount, "comment"),
      tokenDeps,
      fetchImpl: meta.impl,
      now: () => NOW,
      facts: async () => facts(),
    });
    expect(went.externalId).toBe("reply-1");
    expect(path(meta.calls[0])).toBe("/c-9/replies");
    expect(auth(meta.calls[0])).toBe(`Bearer ${secondToken}`);
  });
});

describe("several Pages on one login", () => {
  it("each Page's token is kept by its Page; an older connection's only Page still has its own", () => {
    expect(pageTokenOf(stored, SECOND_PAGE)).toBe(secondToken);
    expect(pageTokenOf(stored, "1000000000000999")).toBeNull();
    const older: StoredToken = { ...stored, token: { access_token: firstToken } };
    expect(pageTokenOf(older, FIRST_PAGE)).toBe(firstToken);
    expect(pageTokenOf(older, SECOND_PAGE)).toBeNull();
  });

  it("every shared Page, and the Instagram account linked to it, is offered", () => {
    const pages = sharedPages({
      pages: [
        { id: FIRST_PAGE, name: "First", instagram_id: null, tasks: ["MANAGE"] },
        {
          id: SECOND_PAGE,
          name: "Second",
          instagram_id: SECOND_IG,
          instagram_username: "second_made_up",
        },
        { id: "not a page id", name: "Odd" },
      ],
    });
    expect(accountsOffered(pages)).toEqual([
      {
        network: "facebook",
        platform_id: FIRST_PAGE,
        page_id: FIRST_PAGE,
        name: "First",
        handle: null,
        tasks: ["MANAGE"],
      },
      {
        network: "facebook",
        platform_id: SECOND_PAGE,
        page_id: SECOND_PAGE,
        name: "Second",
        handle: null,
        tasks: null,
      },
      {
        network: "instagram",
        platform_id: SECOND_IG,
        page_id: SECOND_PAGE,
        name: "Second",
        handle: "second_made_up",
        tasks: null,
      },
    ]);
    expect(sharedPages(null)).toEqual([]);
  });
});
