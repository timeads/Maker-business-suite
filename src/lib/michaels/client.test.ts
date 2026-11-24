import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  MICHAELS_WRITES_ENABLED,
  MichaelsApiError,
  MichaelsWriteRefusedError,
  createMichaelsClient,
  michaelsClientFor,
  type MichaelsEnvName,
} from "./client";
import { parseMichaelsJson } from "./json";

const noSleep = () => Promise.resolve();

function fakeFetch(...replies: { status?: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status ?? 200 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const client = (f: typeof fetch, env: MichaelsEnvName = "sandbox") =>
  createMichaelsClient(
    { connectionId: "conn-1", apiKey: "made-up-key", env },
    { fetchImpl: f, sleep: noSleep, minIntervalMs: 0 },
  );

describe("parseMichaelsJson", () => {
  it("keeps long numeric IDs exact by reading them as strings", () => {
    const out = parseMichaelsJson(
      '{"orderItemId": 1234567890123456789, "quantity": 2, "ids":[9007199254740993]}',
    ) as Record<string, unknown>;
    expect(out.orderItemId).toBe("1234567890123456789");
    expect(out.quantity).toBe(2);
    expect(out.ids).toEqual(["9007199254740993"]);
  });

  it("leaves already-quoted IDs and decimals alone", () => {
    expect(parseMichaelsJson('{"a":"1234567890123456789","p":29.99}')).toEqual({
      a: "1234567890123456789",
      p: 29.99,
    });
  });
});

describe("Michaels client", () => {
  it("sends the key header to the sandbox base URL and unwraps data", async () => {
    const { fn, calls } = fakeFetch({
      body: { code: "200", message: "Succeeded", data: { ok: 1 } },
    });
    const data = await client(fn).request("GET", "/order/query", {
      query: { pageSize: 200, cursor: undefined },
    });
    expect(data).toEqual({ ok: 1 });
    expect(calls[0]!.url).toBe("https://www.michaels.com/api/mkp/v1/uat/order/query?pageSize=200");
    expect((calls[0]!.init.headers as Record<string, string>)["Api-Key"]).toBe("made-up-key");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("uses the production base URL in production", async () => {
    const { fn, calls } = fakeFetch({ body: { code: "200", data: null } });
    await client(fn, "production").request("GET", "/listing/all-listings");
    expect(calls[0]!.url).toBe("https://www.michaels.com/api/mkp/v1/listing/all-listings");
  });

  it("treats a non-200 code as failure even on HTTP 200", async () => {
    const { fn } = fakeFetch({ body: { code: "MCU_API_BAD_REQUEST", message: "bad params" } });
    await expect(client(fn).request("GET", "/order/query")).rejects.toMatchObject({
      code: "MCU_API_BAD_REQUEST",
    });
  });

  it("flags an invalid key as an auth error and never puts the key in the message", async () => {
    const { fn } = fakeFetch({
      status: 401,
      body: { code: "MCU_API_INVALID_API_KEY", message: "invalid" },
    });
    const err: unknown = await client(fn)
      .request("GET", "/order/query")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MichaelsApiError);
    expect((err as MichaelsApiError).isAuthError).toBe(true);
    expect((err as MichaelsApiError).isPermissionError).toBe(false);
    expect((err as Error).message).not.toContain("made-up-key");
  });

  it("tells a key that lacks a permission apart from a bad key", async () => {
    const { fn } = fakeFetch({
      status: 401,
      body: { code: "MCU_DEVELOPER_API_DO_NOT_HAVE_PERMISSION" },
    });
    const err = (await client(fn)
      .request("GET", "/order/query")
      .catch((e: unknown) => e)) as MichaelsApiError;
    expect(err.isPermissionError).toBe(true);
  });

  it("retries reads on a 500, then succeeds", async () => {
    const { fn, calls } = fakeFetch(
      { status: 500, body: { code: "MCU_API_INTERNAL_SERVER_ERROR" } },
      { body: { code: "200", data: [1] } },
    );
    await expect(client(fn).request("GET", "/listing/all-listings")).resolves.toEqual([1]);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a read that was asked not to be repeated", async () => {
    const { fn, calls } = fakeFetch({
      status: 500,
      body: { code: "MCU_API_INTERNAL_SERVER_ERROR" },
    });
    await expect(
      client(fn).request("GET", "/listing/all-listings", { retry: false }),
    ).rejects.toBeInstanceOf(MichaelsApiError);
    expect(calls).toHaveLength(1);
  });

  it("gives up after its retries rather than asking for ever", async () => {
    const { fn, calls } = fakeFetch({ status: 429, body: { code: "TOO_MANY" } });
    await expect(client(fn).request("GET", "/order/query")).rejects.toBeInstanceOf(
      MichaelsApiError,
    );
    expect(calls).toHaveLength(5);
  });

  it("reports a non-envelope reply as a likely wrong route, without echoing it", async () => {
    const { fn } = fakeFetch({ status: 404, body: "<html>Not found: secret-looking-text</html>" });
    const err = (await client(fn)
      .request("GET", "/nope")
      .catch((e: unknown) => e)) as MichaelsApiError;
    expect(err.code).toBe("BAD_RESPONSE");
    expect(err.message).not.toContain("secret-looking-text");
  });

  it("spaces calls out by the minimum gap", async () => {
    const { fn } = fakeFetch({ body: { code: "200", data: null } });
    const sleeps: number[] = [];
    const c = createMichaelsClient(
      { connectionId: "conn-1", apiKey: "made-up-key", env: "sandbox" },
      {
        fetchImpl: fn,
        minIntervalMs: 250,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    await Promise.all([c.request("GET", "/a"), c.request("GET", "/b")]);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(250);
  });

  it("keeps one client per connection, and a new one for a new key", () => {
    const a = michaelsClientFor({ connectionId: "c-9", apiKey: "k1", env: "sandbox" });
    expect(michaelsClientFor({ connectionId: "c-9", apiKey: "k1", env: "sandbox" })).toBe(a);
    expect(michaelsClientFor({ connectionId: "c-9", apiKey: "k2", env: "sandbox" })).not.toBe(a);
  });
});

describe("this stage cannot write", () => {
  it("keeps the writes constant false", () => {
    expect(MICHAELS_WRITES_ENABLED).toBe(false);
  });

  it.each(["POST", "PUT", "DELETE"] as const)(
    "refuses a %s before anything reaches the network",
    async (method) => {
      const { fn, calls } = fakeFetch({ body: { code: "200", data: { sent: true } } });
      const err = await client(fn)
        .request(method, "/listing/inventory/update-inventory-by-seller-sku-number", {
          body: [{ sellerSkuNumber: "MADE-UP-1", availableQuantity: 3 }],
          retry: true,
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MichaelsWriteRefusedError);
      expect(calls).toHaveLength(0);
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it("refuses a method smuggled past the types as well", async () => {
    const { fn, calls } = fakeFetch({ body: { code: "200", data: null } });
    for (const method of ["PATCH", "post", "get", ""]) {
      await expect(client(fn).request(method as never, "/order/confirm")).rejects.toBeInstanceOf(
        MichaelsWriteRefusedError,
      );
    }
    expect(calls).toHaveLength(0);
  });

  it("has no caller that asks for anything but a GET, and one place that fetches", () => {
    const roots = [
      join(__dirname),
      join(__dirname, "..", "connections", "providers"),
      join(__dirname, "..", "..", "..", "worker"),
    ];
    const files = roots.flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts"))
        .filter((f) => dir === __dirname || f.startsWith("michaels") || f === "index.ts")
        .map((f) => join(dir, f)),
    );
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (file.startsWith(__dirname)) {
        // Every call through the client names GET.
        const asked = [...source.matchAll(/\.request(?:<[^>]*>)?\(\s*"([A-Z]+)"/g)].map(
          (m) => m[1],
        );
        expect(
          asked.filter((m) => m !== "GET"),
          file,
        ).toEqual([]);
        // Only the client itself may reach the network.
        if (!file.endsWith("client.ts")) {
          expect(/\bfetch\(/.test(source), `${file} calls fetch`).toBe(false);
        }
      }
      // Nothing sets the constant anywhere but its one declaration.
      const sets = source.match(/MICHAELS_WRITES_ENABLED(?::\s*boolean)?\s*=(?!=)[^;]*/g) ?? [];
      expect(
        sets.filter((s) => s !== "MICHAELS_WRITES_ENABLED: boolean = false"),
        file,
      ).toEqual([]);
    }
  });
});

describe("timeouts", () => {
  it("gives up on a stalled call instead of hanging the run", async () => {
    // Never answers; only the abort signal can end it.
    const stalled: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
        );
      });
    const c = createMichaelsClient(
      { connectionId: "conn-1", apiKey: "k", env: "sandbox" },
      { fetchImpl: stalled, timeoutMs: 50, maxRetries: 0, minIntervalMs: 0 },
    );
    await expect(c.request("GET", "/order/query")).rejects.toThrow(/no reply after/);
  });
});
