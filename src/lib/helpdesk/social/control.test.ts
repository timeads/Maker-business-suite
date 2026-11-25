import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { TokenDeps } from "../../connections/tokens";
import { outboxDetails, outboxWords } from "../outbox";
import { textToRich } from "../rich";
import { parseChannelSettings, type ChannelSettings } from "./channels";
import { controlWords } from "./control";
import { socialPayloadSchema } from "./deliver";
import { parseMetaPayload } from "./events";
import {
  MetaRefused,
  MetaUnsure,
  OWNED_ELSEWHERE,
  ownedElsewhere,
  refusalDetails,
  refusalText,
  refusalWithDetails,
  refusalWords,
  requestThreadControl,
  storedOwnedElsewhere,
  subscribePage,
  subscribedFieldsFor,
  takeThreadControl,
} from "./graph";
import { controlAfter, processMetaPayload, type FileResult, type IntakeDeps } from "./intake";
import { sendSocialReply, type ChannelFacts } from "./server";

/**
 * One tool at a time answers a conversation at Meta ("thread control").
 * Everything here is made up: the ids, the token, and every answer "Meta"
 * gives. Nothing is ever sent to Meta from a test.
 */

const token = randomBytes(24).toString("hex");
const NOW = Date.parse("2026-11-25T15:00:00Z");
const PAGE = "1000000000000001";
const IG = "1784000000000002";
const PERSON = "9000000000000003";
const OURS = "555";
const THEIRS = "777000000000001";
/** Meta Business Suite's own inbox, as Meta's documentation names it. */
const PAGE_INBOX = "263902037430900";

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
const no = (code: number, subcode: number | undefined, message: string, status = 400) =>
  new Response(JSON.stringify({ error: { message, code, error_subcode: subcode } }), { status });
const path = (call: Call) => new URL(call.url).pathname.replace(/^\/v[0-9.]+/, "");

// Meta's words as it sent them on the day, and as its error reference lists them.
const NOT_OWNER = "(#100) The action is invalid since it's not the thread owner.";
const notOwner = () => no(100, 2534037, NOT_OWNER);

describe("a reply Meta refuses because another tool has the conversation", () => {
  it("is known by Meta's numbers, and by its words when the numbers are missing", () => {
    const refusal = (code: number | null, subcode: number | null, reason: string) =>
      ownedElsewhere({ code, subcode, reason });
    // Instagram, Messenger.
    expect(refusal(100, 2534037, "")).toBe(true);
    expect(refusal(10, 2018300, "")).toBe(true);
    // The very sentence seen on staging, with no subcode.
    expect(refusal(100, null, NOT_OWNER)).toBe(true);
    for (const words of [
      "The action is invalid because your app is not the thread owner.",
      "The message failed to send because another app controls the conversation.",
      "(#10) Another app is controlling this thread now.",
      "App is a secondary receiver and does not have thread control",
      "Message cannot be sent while the app is in standby",
    ]) {
      expect(refusal(null, null, words), words).toBe(true);
    }
    // Other refusals with the same code are something else.
    expect(refusal(100, 2018008, "Failed to fetch the file from the url.")).toBe(false);
    expect(refusal(10, 2018278, "outside of allowed window")).toBe(false);
    expect(refusal(190, null, "Error validating access token")).toBe(false);
  });

  it("is explained in plain words, with Meta's own kept for a details line", () => {
    const stored = refusalText(new MetaRefused(400, 100, null, NOT_OWNER));
    expect(stored).toBe(`meta:100:x:none:${NOT_OWNER}`);
    expect(storedOwnedElsewhere(stored)).toBe(true);
    const words = refusalWords(stored);
    expect(words).toBe(OWNED_ELSEWHERE);
    expect(words).toContain("Another inbox tool is answering this conversation");
    expect(words).toContain("nothing was sent");
    expect(words).toContain("Meta Business Suite → Settings → Conversation routing");
    // Our words don't repeat Meta's, and promise no waiting time Meta doesn't.
    expect(words).not.toContain("thread owner");
    expect(words).not.toMatch(/\bhours?\b|\bwait\b/i);
    expect(refusalDetails(stored)).toBe(`Meta said: “${NOT_OWNER}” (code 100)`);
    expect(refusalWithDetails(stored)).toBe(
      `${OWNED_ELSEWHERE} Details: Meta said: “${NOT_OWNER}” (code 100).`,
    );
    // Messenger's, with both numbers.
    const messenger = refusalText(
      new MetaRefused(400, 10, 2018300, "another app controls the conversation"),
    );
    expect(refusalWords(messenger)).toBe(OWNED_ELSEWHERE);
    expect(refusalDetails(messenger)).toBe(
      "Meta said: “another app controls the conversation” (code 10, subcode 2018300)",
    );
    // Pictures refused for it after the words went: both are said.
    expect(refusalWords(`meta:100:2534037:partial:${NOT_OWNER}`)).toBe(
      `Your words were sent, but the pictures weren't. ${OWNED_ELSEWHERE}`,
    );
  });

  it("leaves other refusals as they were, and offers no details where there are none", () => {
    expect(storedOwnedElsewhere("window_closed")).toBe(false);
    expect(storedOwnedElsewhere(null)).toBe(false);
    expect(refusalDetails("window_closed")).toBeNull();
    expect(refusalDetails(null)).toBeNull();
    expect(refusalDetails("meta:190:x:none:")).toBeNull();
    // Where our words already quote Meta's, they aren't said twice.
    const quoted = "meta:100:33:none:Unsupported post request.";
    expect(refusalWords(quoted)).toContain("Unsupported post request.");
    expect(refusalDetails(quoted)).toBeNull();
    expect(refusalWithDetails(quoted)).toBe(refusalWords(quoted));
    // A known refusal in our own words keeps Meta's underneath.
    const window = "meta:10:2018278:none:This message is sent outside of allowed window.";
    expect(refusalWords(window)).toContain("more than 24 hours");
    expect(refusalDetails(window)).toContain("outside of allowed window");
  });

  it("stays in the outbox as failed, with a details line, for a person to try again", () => {
    const row = {
      state: "failed" as const,
      error: `meta:100:2534037:none:${NOT_OWNER}`,
      summary: { kind: "social", to: ["@a_made_up_person"] },
    };
    expect(outboxWords(row)).toBe(`A message to @a_made_up_person wasn't sent. ${OWNED_ELSEWHERE}`);
    expect(outboxDetails(row)).toBe(`Meta said: “${NOT_OWNER}” (code 100, subcode 2534037)`);
    // Nothing of the kind for an email, or for a message still on its way.
    expect(outboxDetails({ ...row, summary: { kind: "reply", to: ["a@b.test"] } })).toBeNull();
    expect(outboxDetails({ ...row, state: "sending" })).toBeNull();
  });
});

describe("asking Meta for a conversation", () => {
  const target = { pageId: PAGE, token, recipientId: PERSON };

  it("takes control through the Page, with the token in the header only", async () => {
    const { impl, calls } = fakeMeta([ok({ success: true })]);
    await takeThreadControl(target, impl);
    expect(calls).toHaveLength(1);
    expect(path(calls[0])).toBe(`/${PAGE}/take_thread_control`);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ recipient: { id: PERSON } });
    expect(calls[0].url).not.toContain(token);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
  });

  it("asks for control the same way", async () => {
    const { impl, calls } = fakeMeta([ok({ success: true })]);
    await requestThreadControl(target, impl);
    expect(path(calls[0])).toBe(`/${PAGE}/request_thread_control`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ recipient: { id: PERSON } });
  });

  it("tells a refusal from no clear answer", async () => {
    await expect(
      takeThreadControl(target, fakeMeta([no(100, undefined, "Not allowed")]).impl),
    ).rejects.toBeInstanceOf(MetaRefused);
    await expect(
      takeThreadControl(target, fakeMeta([new Error("timed out")]).impl),
    ).rejects.toBeInstanceOf(MetaUnsure);
    await expect(
      requestThreadControl(target, fakeMeta([ok({ success: false })]).impl),
    ).rejects.toBeInstanceOf(MetaUnsure);
  });
});

describe("a reply while another tool has the conversation", () => {
  const where = { tenantId: "t1", ticketId: "k1" };
  const payload = socialPayloadSchema.parse({
    kind: "social",
    channel: "instagram",
    doc: textToRich("On its way"),
    then: "pending",
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
  const facts = (settings: Partial<ChannelSettings> = {}): ChannelFacts => ({
    settings: parseChannelSettings({ version: 1, instagram: true, ...settings }),
    connection: {
      status: "active",
      scopes: [
        "pages_manage_metadata",
        "pages_messaging",
        "instagram_basic",
        "instagram_manage_messages",
      ],
      pageName: "A Made Up Page",
      instagramId: IG,
      instagramUsername: "a_made_up_shop",
    },
  });
  /** A stand-in for the database: one Instagram conversation, and the notes written about it. */
  function fakeAdmin(noteFails = false) {
    const notes: string[] = [];
    const admin = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === "social_reply_context") {
          return {
            data: [
              {
                channel: "instagram",
                external_id: PERSON,
                label: "@a_made_up_person",
                last_inbound_at: new Date(NOW - 3600_000).toISOString(),
              },
            ],
            error: null,
          };
        }
        if (name === "note_thread_control") {
          if (noteFails) throw new Error("no such function");
          notes.push(`${args.p_state} ${args.p_external_id} ${args.p_channel} ${args.p_app_id}`);
          return { data: true, error: null };
        }
        return { data: null, error: { message: `unexpected ${name}` } };
      },
      storage: { from: () => ({}) },
    } as unknown as SupabaseClient;
    return { admin, notes };
  }
  const run = (
    db: ReturnType<typeof fakeAdmin>,
    meta: ReturnType<typeof fakeMeta>,
    settings: Partial<ChannelSettings> = {},
  ) =>
    sendSocialReply(where, payload, {
      admin: db.admin,
      tokenDeps,
      fetchImpl: meta.impl,
      now: () => NOW,
      facts: async () => facts(settings),
    });

  it("is off unless a workspace chooses it", () => {
    expect(parseChannelSettings({ version: 1 }).take_control).toBe(false);
    expect(parseChannelSettings({ version: 1, instagram: true }).take_control).toBe(false);
    expect(parseChannelSettings({ version: 1, take_control: true }).take_control).toBe(true);
  });

  it("by default asks Meta once, takes nothing, and notes that another tool has it", async () => {
    const db = fakeAdmin();
    const meta = fakeMeta([notOwner()]);
    const err = await run(db, meta).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaRefused);
    expect(refusalWords(refusalText(err as MetaRefused))).toBe(OWNED_ELSEWHERE);
    // One call, the send. No control was asked for, and nothing was sent again.
    expect(meta.calls.map(path)).toEqual([`/${PAGE}/messages`]);
    expect(db.notes).toEqual([`other ${PERSON} instagram null`]);
  });

  it("notes that we could answer when a reply goes", async () => {
    const db = fakeAdmin();
    const meta = fakeMeta([ok({ message_id: "out-1" })]);
    expect(await run(db, meta)).toEqual({ mids: ["out-1"], problem: null, channel: "instagram" });
    expect(db.notes).toEqual([`ours ${PERSON} instagram null`]);
  });

  it("with the setting on, takes control and sends once more", async () => {
    const db = fakeAdmin();
    const meta = fakeMeta([notOwner(), ok({ success: true }), ok({ message_id: "out-2" })]);
    expect((await run(db, meta, { take_control: true })).mids).toEqual(["out-2"]);
    expect(meta.calls.map(path)).toEqual([
      `/${PAGE}/messages`,
      `/${PAGE}/take_thread_control`,
      `/${PAGE}/messages`,
    ]);
    expect(db.notes).toEqual([`ours ${PERSON} instagram null`]);
  });

  it("asks for it where taking isn't allowed, and gives up when the reply is refused again", async () => {
    const db = fakeAdmin();
    const meta = fakeMeta([
      notOwner(),
      no(100, undefined, "Take thread control is not allowed"),
      ok({ success: true }),
      // The other tool was asked, and still has it.
      notOwner(),
    ]);
    await expect(run(db, meta, { take_control: true })).rejects.toBeInstanceOf(MetaRefused);
    expect(meta.calls.map(path)).toEqual([
      `/${PAGE}/messages`,
      `/${PAGE}/take_thread_control`,
      `/${PAGE}/request_thread_control`,
      `/${PAGE}/messages`,
    ]);
    // Twice at most: never a third try.
    expect(db.notes).toEqual([`other ${PERSON} instagram null`]);
  });

  it("doesn't send again when Meta allows neither", async () => {
    const db = fakeAdmin();
    const meta = fakeMeta([notOwner(), no(100, undefined, "No"), no(100, undefined, "No")]);
    await expect(run(db, meta, { take_control: true })).rejects.toBeInstanceOf(MetaRefused);
    expect(meta.calls.map(path).filter((p) => p.endsWith("/messages"))).toHaveLength(1);
    expect(db.notes).toEqual([`other ${PERSON} instagram null`]);
  });

  it("asks for nothing on any other refusal, or when there was no clear answer", async () => {
    const window = fakeMeta([no(10, 2018278, "outside of allowed window")]);
    const db = fakeAdmin();
    await expect(run(db, window, { take_control: true })).rejects.toBeInstanceOf(MetaRefused);
    expect(window.calls).toHaveLength(1);
    const silent = fakeMeta([new Error("timed out")]);
    await expect(run(db, silent, { take_control: true })).rejects.toBeInstanceOf(MetaUnsure);
    // It may have gone: nothing more is asked, and nothing is sent again.
    expect(silent.calls).toHaveLength(1);
    expect(db.notes).toEqual([]);
  });

  it("no clear answer to the second try is still no clear answer", async () => {
    const meta = fakeMeta([notOwner(), ok({ success: true }), new Error("timed out")]);
    await expect(run(fakeAdmin(), meta, { take_control: true })).rejects.toBeInstanceOf(MetaUnsure);
    expect(meta.calls).toHaveLength(3);
  });

  it("goes the same whether or not the note can be written", async () => {
    const sent = fakeMeta([ok({ message_id: "out-3" })]);
    expect((await run(fakeAdmin(true), sent)).mids).toEqual(["out-3"]);
    await expect(run(fakeAdmin(true), fakeMeta([notOwner()]))).rejects.toBeInstanceOf(MetaRefused);
  });
});

describe("what Meta delivers when more than one tool is connected", () => {
  const text = (mid: string, words: string) => ({
    sender: { id: PERSON },
    recipient: { id: IG },
    timestamp: NOW - 5000,
    message: { mid, text: words },
  });
  const delivery = (
    object: "page" | "instagram",
    account: string,
    lists: { messaging?: unknown[]; standby?: unknown[] },
  ) => ({ object, entry: [{ id: account, time: NOW, ...lists }] });
  const handover = (kind: string, body: Record<string, unknown>, account = IG) => ({
    sender: { id: PERSON },
    recipient: { id: account },
    timestamp: NOW - 1000,
    [kind]: body,
  });

  it("reads a message the same from `messaging` and from `standby`, and says which", () => {
    const [mine] = parseMetaPayload(
      delivery("instagram", IG, { messaging: [text("m-1", "Hello")] }),
      NOW,
    );
    const [theirs] = parseMetaPayload(
      delivery("instagram", IG, { standby: [text("m-1", "Hello")] }),
      NOW,
    );
    expect(mine).toMatchObject({ type: "message", mid: "m-1", text: "Hello", personId: PERSON });
    expect(mine).not.toHaveProperty("standby");
    expect(theirs).toEqual({ ...mine, standby: true });
    // Messenger's standby is the same shape under the Page.
    const [page] = parseMetaPayload(
      delivery("page", PAGE, {
        standby: [{ ...text("m-2", "Hi"), recipient: { id: PAGE } }],
      }),
      NOW,
    );
    expect(page).toMatchObject({ channel: "facebook", type: "message", standby: true });
  });

  it("reads both lists in one delivery, and still leaves out reads and postbacks", () => {
    const events = parseMetaPayload(
      delivery("instagram", IG, {
        messaging: [text("m-1", "One")],
        standby: [
          text("m-2", "Two"),
          { sender: { id: PERSON }, recipient: { id: IG }, timestamp: NOW, read: { mid: "m-0" } },
          // A postback on standby comes without its payload: nothing to file.
          {
            sender: { id: PERSON },
            recipient: { id: IG },
            timestamp: NOW,
            postback: { title: "Hi" },
          },
          { sender: { id: PERSON }, recipient: { id: IG }, timestamp: NOW, message: { mid: "" } },
        ],
      }),
      NOW,
    );
    expect(
      events.map((e) => (e.type === "message" ? `${e.mid}:${e.standby ?? false}` : e.type)),
    ).toEqual(["m-1:false", "m-2:true"]);
  });

  it("reads a conversation changing hands, and who has it", () => {
    const events = parseMetaPayload(
      delivery("instagram", IG, {
        messaging: [
          handover("pass_thread_control", {
            previous_owner_app_id: THEIRS,
            new_owner_app_id: OURS,
            metadata: "anything the other tool wrote, which is never kept",
          }),
          // Meta sends the app id as a number in places.
          handover("take_thread_control", {
            previous_owner_app_id: OURS,
            new_owner_app_id: Number(PAGE_INBOX),
          }),
          handover("request_thread_control", { requested_owner_app_id: THEIRS }),
          // A handed-over conversation from idle: no previous owner, no new one named.
          handover("pass_thread_control", { previous_owner_app_id: null }),
          // An app's role changing is not about one conversation.
          { recipient: { id: IG }, timestamp: NOW, app_roles: { [OURS]: ["primary_receiver"] } },
          handover("take_thread_control", { new_owner_app_id: "not an app id" }),
        ],
      }),
      NOW,
    );
    expect(events).toEqual([
      expect.objectContaining({ type: "control", change: "pass", appId: OURS, personId: PERSON }),
      expect.objectContaining({ type: "control", change: "take", appId: PAGE_INBOX }),
      expect.objectContaining({ type: "control", change: "request", appId: THEIRS }),
      expect.objectContaining({ type: "control", change: "pass", appId: null }),
      expect.objectContaining({ type: "control", change: "take", appId: null }),
    ]);
    expect(JSON.stringify(events)).not.toContain("never kept");
  });

  it("works out whose it is: the named app when we know ours, else by which notice it was", () => {
    expect(controlAfter("pass", OURS, OURS)).toBe("ours");
    expect(controlAfter("pass", THEIRS, OURS)).toBe("other");
    expect(controlAfter("take", THEIRS, OURS)).toBe("other");
    expect(controlAfter("take", OURS, OURS)).toBe("ours");
    // Meta tells the receiver about a pass and the loser about a take.
    expect(controlAfter("pass", null, OURS)).toBe("ours");
    expect(controlAfter("pass", THEIRS, null)).toBe("ours");
    expect(controlAfter("take", null, null)).toBe("other");
  });

  describe("and what the help desk does with it", () => {
    function deps(over: Partial<IntakeDeps> = {}) {
      const calls: string[] = [];
      const base: IntakeDeps = {
        now: () => NOW,
        ourAppId: OURS,
        whereFor: async (channel, account) =>
          account === IG ? { tenantId: "t1", pageId: PAGE, channel } : null,
        rulesFor: async () => ({ version: 1, rules: [] }) as never,
        file: async (_where, event) => {
          calls.push(`file ${event.mid}`);
          return {
            result: event.mid === "seen" ? "duplicate" : "created",
            ticket_id: "k1",
            message_id: "msg1",
            contact_id: "c1",
            number: 7,
          } satisfies FileResult;
        },
        echo: async () => ({ result: "threaded" }),
        remove: async () => undefined,
        react: async () => undefined,
        noteControl: async (_where, person, state, appId) =>
          void calls.push(`note ${state} ${person} ${appId}`),
        ...over,
      };
      return { base, calls };
    }

    it("files a standby message like any other, and notes another tool has the conversation", async () => {
      const { base, calls } = deps();
      const outcomes = await processMetaPayload(
        delivery("instagram", IG, { standby: [text("m-9", "Is this still available?")] }),
        base,
      );
      expect(outcomes).toEqual(["created (standby)"]);
      expect(calls).toEqual(["file m-9", `note other ${PERSON} null`]);
    });

    it("files a message from `messaging` without claiming anything about who answers", async () => {
      // The delivery seen on staging: filed from `messaging`, and the reply still refused.
      const { base, calls } = deps();
      expect(
        await processMetaPayload(
          delivery("instagram", IG, { messaging: [text("m-10", "Hello")] }),
          base,
        ),
      ).toEqual(["created"]);
      expect(calls).toEqual(["file m-10"]);
    });

    it("notes a hand-over, files nothing for it, and hands nothing over when asked", async () => {
      const { base, calls } = deps();
      const outcomes = await processMetaPayload(
        delivery("instagram", IG, {
          messaging: [
            handover("take_thread_control", { new_owner_app_id: PAGE_INBOX }),
            handover("pass_thread_control", { new_owner_app_id: OURS }),
            handover("request_thread_control", { requested_owner_app_id: THEIRS }),
          ],
        }),
        base,
      );
      expect(outcomes).toEqual(["control other", "control ours", "control asked"]);
      // The other tool is named only while it has the conversation.
      expect(calls).toEqual([`note other ${PERSON} ${PAGE_INBOX}`, `note ours ${PERSON} null`]);
    });

    it("drops a hand-over for an account nobody connected, and survives a note that can't be written", async () => {
      const { base, calls } = deps({
        noteControl: async () => {
          throw new Error("no such function");
        },
      });
      expect(
        await processMetaPayload(
          delivery("instagram", "1784000000009999", {
            messaging: [
              handover("pass_thread_control", { new_owner_app_id: OURS }, "1784000000009999"),
            ],
          }),
          base,
        ),
      ).toEqual(["dropped"]);
      expect(
        await processMetaPayload(
          delivery("instagram", IG, {
            messaging: [handover("take_thread_control", { new_owner_app_id: THEIRS })],
            standby: [text("m-11", "Hello?")],
          }),
          base,
        ),
      ).toEqual(["control other", "created (standby)"]);
      expect(calls).toEqual(["file m-11"]);
    });

    it("works without the note at all", async () => {
      const { base } = deps({ noteControl: undefined });
      expect(
        await processMetaPayload(
          delivery("instagram", IG, { standby: [text("m-12", "Hi")] }),
          base,
        ),
      ).toEqual(["created (standby)"]);
    });
  });
});

describe("what a Page is asked to send", () => {
  it("includes standby and hand-overs with messages, and never for comments alone", () => {
    expect(subscribedFieldsFor({ messages: true, comments: false })).toEqual([
      "messages",
      "message_echoes",
      "message_reactions",
      "standby",
      "messaging_handovers",
    ]);
    expect(subscribedFieldsFor({ messages: false, comments: true })).toEqual(["feed"]);
  });

  it("subscribes without them if Meta won't have them, so messages still arrive", async () => {
    const fields = subscribedFieldsFor({ messages: true, comments: true });
    const { impl, calls } = fakeMeta([
      no(100, undefined, "Param subscribed_fields must be one of ..."),
      ok({ success: true }),
    ]);
    await subscribePage(PAGE, token, impl, fields);
    expect(calls.map((call) => new URL(call.url).searchParams.get("subscribed_fields"))).toEqual([
      "messages,message_echoes,message_reactions,standby,messaging_handovers,feed",
      "messages,message_echoes,message_reactions,feed",
    ]);
    // A refusal that isn't about them is still a refusal.
    const refused = fakeMeta([no(190, undefined, "Bad token"), no(190, undefined, "Bad token")]);
    await expect(subscribePage(PAGE, token, refused.impl, fields)).rejects.toBeInstanceOf(
      MetaRefused,
    );
    // And nothing is tried twice when they weren't asked for.
    const plain = fakeMeta([no(100, undefined, "No")]);
    await expect(subscribePage(PAGE, token, plain.impl, ["feed"])).rejects.toBeInstanceOf(
      MetaRefused,
    );
    expect(plain.calls).toHaveLength(1);
  });
});

describe("what the team is told about who is answering", () => {
  const at = "2026-11-25T14:30:00Z";
  const time = () => "25 Nov, 9:30 AM ET";

  it("says nothing when we never heard, or when the conversation is ours", () => {
    expect(controlWords(null, "instagram", time)).toBeNull();
    expect(controlWords({ state: null, appId: null, at: null }, "instagram", time)).toBeNull();
    expect(controlWords({ state: "ours", appId: null, at }, "instagram", time)).toBeNull();
    expect(controlWords({ state: "sideways", appId: null, at }, "instagram", time)).toBeNull();
  });

  it("says another tool had it, when we heard, and that a reply may be refused", () => {
    const words = controlWords({ state: "other", appId: THEIRS, at }, "instagram", time);
    expect(words).toBe(
      "Another inbox tool was answering this conversation on Instagram when we last heard (25 Nov, 9:30 AM ET). A reply from here may be refused until that tool lets go of it.",
    );
    // An app id means nothing to a person: it is never shown.
    expect(words).not.toContain(THEIRS);
  });

  it("names Meta's own inboxes, which it can recognise", () => {
    expect(controlWords({ state: "other", appId: PAGE_INBOX, at }, "facebook", time)).toContain(
      "Meta Business Suite's inbox was answering this conversation on Facebook",
    );
    expect(
      controlWords({ state: "other", appId: "1217981644879628", at }, "instagram", time),
    ).toContain("Instagram's own inbox was answering");
  });
});
