import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };
type Ingest = { result: string; ticket_id?: string; number?: number; tenant_id?: string };

let db: PGlite;
let alice: User;
let bob: User;
let tenantA: string;
let tenantB: string;
let n = 0;

const TABLES = ["contacts", "tickets", "messages", "tags", "ticket_tags"];

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'UTC', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}

function service<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}

async function email(
  slug: string,
  from: string,
  subject: string,
  opts: {
    id?: string;
    messageId?: string;
    replyKey?: string;
    references?: string[];
    tags?: string[];
    name?: string;
  } = {},
): Promise<Ingest> {
  n += 1;
  const rows = await service<{ r: Ingest }>(
    "select public.ingest_inbound_email($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as r",
    [
      slug,
      opts.id ?? `pm-${n}`,
      from,
      opts.name ?? null,
      subject,
      `Body of ${subject}`,
      opts.messageId ?? `<msg-${n}@mail.test>`,
      opts.replyKey ?? null,
      opts.references ?? [],
      opts.tags ?? [],
    ],
  );
  return rows[0].r;
}

const replyKey = async (ticketId: string) =>
  (
    await db.query<{ reply_key: string }>("select reply_key from public.tickets where id = $1", [
      ticketId,
    ])
  ).rows[0].reply_key;

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
});

describe("inbound email", () => {
  it("an email to a workspace's address becomes ticket #1, with the sender as a contact", async () => {
    const result = await email("alice-rugs", "Sam@Example.com", "Where is my rug?", {
      name: "Sam Shopper",
      tags: ["shipping"],
    });
    expect(result).toMatchObject({ result: "created", number: 1, tenant_id: tenantA });

    await asUser(db, alice, async (tx) => {
      const tickets = await tx.query("select number, subject, status from public.tickets");
      expect(tickets.rows).toEqual([{ number: 1, subject: "Where is my rug?", status: "open" }]);
      const contacts = await tx.query("select email, name from public.contacts");
      expect(contacts.rows).toEqual([{ email: "sam@example.com", name: "Sam Shopper" }]);
      const messages = await tx.query("select direction, from_email, body from public.messages");
      expect(messages.rows).toEqual([
        { direction: "inbound", from_email: "sam@example.com", body: "Body of Where is my rug?" },
      ]);
      const tags = await tx.query(
        "select t.name from public.ticket_tags tt join public.tags t on t.id = tt.tag_id",
      );
      expect(tags.rows).toEqual([{ name: "shipping" }]);
    });
  });

  it("numbers tickets per workspace", async () => {
    expect((await email("alice-rugs", "kim@example.com", "Custom size?")).number).toBe(2);
    expect((await email("bob-pottery", "sam@example.com", "Chipped mug")).number).toBe(1);
  });

  it("stores a redelivered email once", async () => {
    const first = await email("alice-rugs", "lee@example.com", "Hello", { id: "pm-dupe" });
    const again = await email("alice-rugs", "lee@example.com", "Hello", { id: "pm-dupe" });
    expect(first.result).toBe("created");
    expect(again.result).toBe("duplicate");
    const { rows } = await db.query(
      "select 1 from public.messages where provider_message_id = 'pm-dupe'",
    );
    expect(rows).toHaveLength(1);
  });

  it("says so when the address matches no workspace, and stores nothing", async () => {
    const before = (await db.query("select 1 from public.messages")).rows.length;
    expect((await email("no-such-studio", "x@example.com", "Hi")).result).toBe("unknown_workspace");
    expect((await db.query("select 1 from public.messages")).rows.length).toBe(before);
  });
});

describe("threading", () => {
  it("a reply to the ticket's own address joins that ticket and reopens it", async () => {
    const created = await email("alice-rugs", "pat@example.com", "Order question");
    await asUser(db, alice, (tx) =>
      tx.query("select public.set_ticket_status($1, 'closed')", [created.ticket_id]),
    );

    const reply = await email("alice-rugs", "pat@example.com", "Re: Order question", {
      replyKey: await replyKey(created.ticket_id!),
    });
    expect(reply).toMatchObject({ result: "threaded", ticket_id: created.ticket_id });
    const { rows } = await db.query<{ status: string; n: number }>(
      "select t.status, (select count(*)::int from public.messages m where m.ticket_id = t.id) as n from public.tickets t where t.id = $1",
      [created.ticket_id],
    );
    expect(rows).toEqual([{ status: "open", n: 2 }]);
  });

  it("falls back to the email's own headers when the reply came to the plain address", async () => {
    const created = await email("alice-rugs", "quinn@example.com", "Wholesale?", {
      messageId: "<first@mail.test>",
    });
    const reply = await email("alice-rugs", "quinn@example.com", "Re: Wholesale?", {
      references: ["<unrelated@mail.test>", "<first@mail.test>"],
    });
    expect(reply).toMatchObject({ result: "threaded", ticket_id: created.ticket_id });
  });

  it("the same subject from the same person, with nothing linking it, is a new ticket", async () => {
    const one = await email("alice-rugs", "rae@example.com", "Question");
    const two = await email("alice-rugs", "rae@example.com", "Question");
    expect(two.result).toBe("created");
    expect(two.ticket_id).not.toBe(one.ticket_id);
  });

  it("a reply key or message id from another workspace does not cross over", async () => {
    const theirs = await email("bob-pottery", "tess@example.com", "B's ticket", {
      messageId: "<b-only@mail.test>",
    });
    const viaKey = await email("alice-rugs", "attacker@example.com", "sneak", {
      replyKey: await replyKey(theirs.ticket_id!),
    });
    const viaHeader = await email("alice-rugs", "attacker@example.com", "sneak", {
      references: ["<b-only@mail.test>"],
    });
    for (const result of [viaKey, viaHeader]) {
      expect(result.result).toBe("created");
      expect(result.tenant_id).toBe(tenantA);
    }
    const { rows } = await db.query("select 1 from public.messages where ticket_id = $1", [
      theirs.ticket_id,
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe("cross-tenant isolation for the help desk", () => {
  it("each workspace sees only its own contacts, tickets, messages and tags", async () => {
    await email("bob-pottery", "uma@example.com", "Tagged for B", { tags: ["wholesale"] });
    for (const [who, tenant] of [
      [alice, tenantA],
      [bob, tenantB],
    ] as const) {
      await asUser(db, who, async (tx) => {
        for (const table of TABLES) {
          const { rows } = await tx.query<{ tenant_id: string }>(
            `select tenant_id from public.${table}`,
          );
          expect(rows.length, `${table} for ${who.email}`).toBeGreaterThan(0);
          expect(
            rows.every((r) => r.tenant_id === tenant),
            `${table} leaked`,
          ).toBe(true);
        }
      });
    }
  });

  it("a member cannot reply to, close or tag another workspace's ticket", async () => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.tickets where tenant_id = $1 limit 1",
      [tenantB],
    );
    const theirs = rows[0].id;
    for (const sql of [
      `select public.record_reply('${theirs}', 'hi', 'support@a.test', 'out-x')`,
      `select public.set_ticket_status('${theirs}', 'closed')`,
      `select public.set_ticket_tags('${theirs}', array['spam'])`,
    ]) {
      await expect(
        asUser(db, alice, (tx) => tx.query(sql)),
        sql,
      ).rejects.toThrow(/not found/i);
    }
  });

  it("clients cannot read reply keys, write tables directly, or call the service functions", async () => {
    const attempts = [
      "select reply_key from public.tickets",
      "select * from public.tickets",
      "update public.tickets set status = 'closed'",
      "delete from public.messages",
      `insert into public.messages (tenant_id, ticket_id, direction, from_email, body) select tenant_id, id, 'outbound', 'x@x.test', 'x' from public.tickets limit 1`,
      "insert into public.tags (tenant_id, name) select tenant_id, 'x' from public.tickets limit 1",
      "select * from private.inbound_emails",
      "select public.enqueue_inbound_email('x', '{}')",
      "select * from public.claim_inbound_emails(1)",
      "select public.ingest_inbound_email('alice-rugs', 'x', 'x@x.test', null, 's', 'b')",
      `select * from public.ticket_reply_context('${tenantA}', '${tenantA}')`,
    ];
    for (const sql of attempts) {
      await expect(
        asUser(db, alice, (tx) => tx.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/i);
    }
    for (const table of TABLES) {
      await expect(
        asAnon(db, (tx) => tx.query(`select 1 from public.${table}`)),
        table,
      ).rejects.toThrow(/permission denied/i);
    }
  });
});

describe("replying and tagging", () => {
  it("records a teammate's reply once, marks the ticket as waiting, and keeps the thread in order", async () => {
    const created = await email("alice-rugs", "val@example.com", "Do you ship to Canada?");
    const send = () =>
      asUser(db, alice, (tx) =>
        tx.query(
          "select public.record_reply($1, 'Yes we do!', 'support-alice-rugs@in.test', 'out-1', '<out-1@pm.test>')",
          [created.ticket_id],
        ),
      );
    await send();
    await send(); // a retried request

    const thread = await db.query<{ direction: string; author_id: string | null }>(
      "select direction, author_id from public.messages where ticket_id = $1 order by created_at",
      [created.ticket_id],
    );
    expect(thread.rows).toEqual([
      { direction: "inbound", author_id: null },
      { direction: "outbound", author_id: alice.id },
    ]);
    const status = await db.query<{ status: string }>(
      "select status from public.tickets where id = $1",
      [created.ticket_id],
    );
    expect(status.rows[0].status).toBe("pending");

    // The customer replying to our message threads by its Message-ID too.
    const back = await email("alice-rugs", "val@example.com", "Re: Do you ship to Canada?", {
      references: ["<out-1@pm.test>"],
    });
    expect(back).toMatchObject({ result: "threaded", ticket_id: created.ticket_id });

    await expect(
      asUser(db, alice, (tx) =>
        tx.query("select public.record_reply($1, '   ', 'x@x.test', 'out-2')", [created.ticket_id]),
      ),
    ).rejects.toThrow(/needs some words/i);
  });

  it("gives the app server what it needs to address a reply", async () => {
    const created = await email("alice-rugs", "wes@example.com", "Invoice copy", {
      messageId: "<wes-1@mail.test>",
      name: "Wes",
    });
    const rows = await service<Record<string, string>>(
      "select * from public.ticket_reply_context($1, $2)",
      [tenantA, created.ticket_id],
    );
    expect(rows[0]).toMatchObject({
      subject: "Invoice copy",
      contact_email: "wes@example.com",
      contact_name: "Wes",
      last_message_id: "<wes-1@mail.test>",
    });
    expect(rows[0].reply_key).toMatch(/^[0-9a-f]{32}$/);
    // Asking with the wrong workspace finds nothing.
    expect(
      await service("select * from public.ticket_reply_context($1, $2)", [
        tenantB,
        created.ticket_id,
      ]),
    ).toEqual([]);
  });

  it("replaces a ticket's tags, tidying the names and reusing existing tags", async () => {
    const created = await email("alice-rugs", "xan@example.com", "Tag me", { tags: ["shipping"] });
    await asUser(db, alice, (tx) =>
      tx.query("select public.set_ticket_tags($1, array[' Wholesale ', 'shipping', 'bad/tag!'])", [
        created.ticket_id,
      ]),
    );
    const tags = await db.query<{ name: string }>(
      "select t.name from public.ticket_tags tt join public.tags t on t.id = tt.tag_id where tt.ticket_id = $1 order by t.name",
      [created.ticket_id],
    );
    expect(tags.rows).toEqual([{ name: "shipping" }, { name: "wholesale" }]);
    const all = await db.query(
      "select 1 from public.tags where tenant_id = $1 and name = 'shipping'",
      [tenantA],
    );
    expect(all.rows).toHaveLength(1);
  });
});

describe("the inbound queue", () => {
  it("takes an email once, hands it to one worker, and drops the payload when done", async () => {
    const enqueue = async (id: string) =>
      (
        await service<{ ok: boolean }>(
          'select public.enqueue_inbound_email($1, \'{"Subject":"hi"}\') as ok',
          [id],
        )
      )[0].ok;
    expect(await enqueue("in-1")).toBe(true);
    expect(await enqueue("in-1")).toBe(false);

    const claimed = await service<{ id: string; attempts: number }>(
      "select id, attempts from public.claim_inbound_emails(5)",
    );
    expect(claimed).toEqual([{ id: "in-1", attempts: 1 }]);
    expect(await service("select id from public.claim_inbound_emails(5)")).toEqual([]);

    await service("select public.complete_inbound_email('in-1')");
    const { rows } = await db.query<{ payload: object; done: boolean }>(
      "select payload, processed_at is not null as done from private.inbound_emails where id = 'in-1'",
    );
    expect(rows).toEqual([{ payload: {}, done: true }]);
  });
});

describe("plan choices and privacy", () => {
  it("only owners and admins choose their plan's optional tools, from the real list", async () => {
    await service(
      "insert into public.subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status) values ($1, 'cus_a', 'sub_a', 'starter', 'active')",
      [tenantA],
    );
    await asUser(db, alice, (tx) =>
      tx.query("select public.choose_modules($1, array['helpdesk'])", [tenantA]),
    );
    const { rows } = await db.query<{ selected_modules: string[] }>(
      "select selected_modules from public.subscriptions where tenant_id = $1",
      [tenantA],
    );
    expect(rows[0].selected_modules).toEqual(["helpdesk"]);
    await expect(
      asUser(db, bob, (tx) =>
        tx.query("select public.choose_modules($1, array['helpdesk'])", [tenantA]),
      ),
    ).rejects.toThrow(/owners and admins/i);
    await expect(
      asUser(db, alice, (tx) =>
        tx.query("select public.choose_modules($1, array['dashboard', 'everything'])", [tenantA]),
      ),
    ).rejects.toThrow(/not one you can choose/i);
  });

  it("erasing a shopper also removes their help desk conversations, in that workspace only", async () => {
    await email("alice-rugs", "sam@example.com", "Another from Sam");
    await service("select public.redact_customer($1, 'shopify', 'cust-sam', 'Sam@Example.com')", [
      tenantA,
    ]);
    const mine = await db.query(
      "select 1 from public.contacts where tenant_id = $1 and email = 'sam@example.com'",
      [tenantA],
    );
    expect(mine.rows).toHaveLength(0);
    const tickets = await db.query(
      "select 1 from public.messages where tenant_id = $1 and from_email = 'sam@example.com'",
      [tenantA],
    );
    expect(tickets.rows).toHaveLength(0);
    // Sam also wrote to Bob's shop; that stays.
    const theirs = await db.query(
      "select 1 from public.contacts where tenant_id = $1 and email = 'sam@example.com'",
      [tenantB],
    );
    expect(theirs.rows).toHaveLength(1);
  });
});
