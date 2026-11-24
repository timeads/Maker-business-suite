import { describe, expect, it } from "vitest";
import {
  ZEBRA_AGENTS,
  ZEBRA_MESSAGES,
  ZebraError,
  createZebraClient,
  parseZebraStatus,
  splitLabels,
} from "./client";

const HTTPS = "https://localhost:9101";
const HTTP = "http://localhost:9100";
const ZT = { name: "ZT220", uid: "usb-zt220", connection: "usb", deviceType: "printer" };
const NET = { name: "ZD420 upstairs", uid: "10.0.0.9:9100", connection: "network" };

type Call = { url: string; method: string; type: string | null; body: string };
type Reply = { status?: number; text?: string; json?: unknown } | "down";

/** Browser Print played from a script: each call is answered by `answer`, or the connection fails. */
function agent(answer: (call: Call, calls: Call[]) => Reply) {
  const calls: Call[] = [];
  const fetch = async (input: string, init: RequestInit = {}) => {
    const call: Call = {
      url: input,
      method: init.method ?? "GET",
      type: new Headers(init.headers).get("content-type"),
      body: typeof init.body === "string" ? init.body : "",
    };
    calls.push(call);
    const reply = answer(call, calls);
    // What a browser throws when nothing is listening.
    if (reply === "down") throw new TypeError("Failed to fetch");
    return new Response(reply.text ?? JSON.stringify(reply.json ?? {}), {
      status: reply.status ?? 200,
    });
  };
  const client = createZebraClient({
    fetch,
    sleep: async () => undefined,
    permission: async () => null,
  });
  return { client, calls };
}

const path = (call: Call) => call.url.replace(/^https?:\/\/localhost:\d+/, "");
const written = (calls: Call[]) =>
  calls
    .filter((call) => path(call) === "/write")
    .map((call) => JSON.parse(call.body) as { device: unknown; data: string });

/** A healthy Browser Print with one default printer and one more on the network. */
const healthy = (call: Call): Reply => {
  if (path(call) === "/default?type=printer") return { json: ZT };
  if (path(call) === "/available") return { json: { printer: [NET, ZT] } };
  return { text: "" };
};

describe("finding the printer", () => {
  it("asks Browser Print on this computer, at the addresses it listens on", async () => {
    expect([...ZEBRA_AGENTS]).toEqual([HTTPS, HTTP]);
    const { client, calls } = agent(healthy);
    const found = await client.findPrinters();
    // Its default first, then anything else it can see; never the same one twice.
    expect(found.map((device) => device.name)).toEqual(["ZT220", "ZD420 upstairs"]);
    expect(calls.map((call) => call.url)).toEqual([
      `${HTTPS}/default?type=printer`,
      `${HTTPS}/available`,
    ]);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("uses the plain address when the secure one isn't trusted yet, and remembers which answered", async () => {
    const { client, calls } = agent((call) =>
      call.url.startsWith(HTTPS) ? "down" : healthy(call),
    );
    expect((await client.pickPrinter()).name).toBe("ZT220");
    expect(calls.map((call) => call.url)).toEqual([
      `${HTTPS}/default?type=printer`,
      `${HTTP}/default?type=printer`,
      // The one that answered is tried first from then on.
      `${HTTP}/available`,
    ]);
  });

  it("prefers the printer picked on this computer while Browser Print still offers it", async () => {
    const { client } = agent(healthy);
    expect((await client.pickPrinter("ZD420 upstairs")).uid).toBe(NET.uid);
    expect((await client.pickPrinter("A printer that has gone")).uid).toBe(ZT.uid);
    expect((await client.pickPrinter("")).uid).toBe(ZT.uid);
  });

  it("falls back to a printer it can see when the default comes back empty or half there", async () => {
    for (const text of ["", "{}", JSON.stringify({ uid: "x" }), "not json"]) {
      const { client } = agent((call) =>
        path(call) === "/default?type=printer" ? { text } : healthy(call),
      );
      // USB before network.
      expect((await client.findPrinters()).map((device) => device.name)).toEqual([
        "ZT220",
        "ZD420 upstairs",
      ]);
    }
  });

  it("says plainly when Browser Print isn't running", async () => {
    const { client, calls } = agent(() => "down");
    const err = await client.findPrinters().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZebraError);
    expect((err as ZebraError).problem).toBe("not-running");
    expect((err as ZebraError).message).toBe(ZEBRA_MESSAGES["not-running"]);
    expect((err as ZebraError).message).toMatch(/installed and running/);
    // Both addresses were tried before giving up.
    expect(calls.map((call) => call.url)).toEqual([
      `${HTTPS}/default?type=printer`,
      `${HTTP}/default?type=printer`,
    ]);
  });

  it("says so when the browser itself is blocking the page", async () => {
    const client = createZebraClient({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
      permission: async () => "denied",
    });
    await expect(client.findPrinters()).rejects.toMatchObject({
      problem: "blocked",
      message: ZEBRA_MESSAGES.blocked,
    });
  });

  it("says so when Browser Print is running but sees no printer", async () => {
    const { client } = agent((call) =>
      path(call) === "/available" ? { json: { printer: [] } } : { text: "" },
    );
    await expect(client.findPrinters()).rejects.toMatchObject({
      problem: "no-printer",
      message: ZEBRA_MESSAGES["no-printer"],
    });
    // Older versions can't list printers at all: the same answer.
    const old = agent((call) => (path(call) === "/available" ? { status: 404 } : { text: "" }));
    await expect(old.client.findPrinters()).rejects.toMatchObject({ problem: "no-printer" });
  });
});

describe("sending labels", () => {
  it("splits a run into whole labels", () => {
    expect(splitLabels("^XA^FDone^FS^XZ\n^XA^FDtwo^FS^XZ")).toEqual([
      "^XA^FDone^FS^XZ",
      "^XA^FDtwo^FS^XZ",
    ]);
    expect(splitLabels("~HQES")).toEqual(["~HQES"]);
  });

  it("writes each label to the chosen printer, in order, as a plain-text request", async () => {
    const { client, calls } = agent(healthy);
    const sent = await client.send("^XA^FDone^FS^XZ\n^XA^FDtwo^FS^XZ", "ZT220");
    expect(sent).toMatchObject({ labels: 2, device: { name: "ZT220" } });
    const writes = written(calls);
    // An empty write first checks the printer takes anything at all.
    expect(writes.map((write) => write.data)).toEqual(["", "^XA^FDone^FS^XZ", "^XA^FDtwo^FS^XZ"]);
    // The printer goes back exactly as Browser Print described it.
    expect(writes.every((write) => JSON.stringify(write.device) === JSON.stringify(ZT))).toBe(true);
    for (const call of calls.filter((each) => path(each) === "/write")) {
      expect(call.method).toBe("POST");
      // text/plain: the browser sends it without asking first.
      expect(call.type).toBe("text/plain;charset=UTF-8");
    }
  });

  it("sends a big label in pieces the printer joins up", async () => {
    const { client, calls } = agent(healthy);
    const big = `^XA^FX${"x".repeat(9000)}^XZ`;
    await client.send(big);
    const pieces = written(calls).slice(1);
    expect(pieces.map((piece) => piece.data.length)).toEqual([4000, 4000, big.length - 8000]);
    expect(pieces.map((piece) => piece.data).join("")).toBe(big);
  });

  it("tries a refused piece again in smaller pieces before giving up", async () => {
    // Browser Print here refuses anything over 1,000 characters.
    const { client, calls } = agent((call) => {
      if (path(call) !== "/write") return healthy(call);
      return (JSON.parse(call.body) as { data: string }).data.length > 1000
        ? { status: 500 }
        : { text: "" };
    });
    const big = `^XA^FX${"y".repeat(3000)}^XZ`;
    await client.send(big);
    const ok = written(calls).filter((write) => write.data.length <= 1000);
    expect(ok.map((write) => write.data).join("")).toBe(big);
    expect(Math.max(...ok.map((write) => write.data.length))).toBe(1000);
  });

  it("uses another printer it can see when the chosen one won't take anything", async () => {
    const { client, calls } = agent((call) => {
      if (path(call) !== "/write") return healthy(call);
      const { device } = JSON.parse(call.body) as { device: { uid: string } };
      return device.uid === ZT.uid ? { status: 500 } : { text: "" };
    });
    const sent = await client.send("^XA^FDone^FS^XZ");
    expect(sent.device.name).toBe("ZD420 upstairs");
    expect(written(calls).at(-1)).toMatchObject({ device: NET, data: "^XA^FDone^FS^XZ" });
  });

  it("says which label it stopped at and how many came out, and closes the half-sent one", async () => {
    let labelWrites = 0;
    const { client, calls } = agent((call) => {
      if (path(call) !== "/write") return healthy(call);
      const { data } = JSON.parse(call.body) as { data: string };
      if (data === "" || data === "^XZ") return { text: "" };
      labelWrites += 1;
      // The first label goes; then the printer stops taking anything.
      return labelWrites === 1 ? { text: "" } : { status: 500 };
    });
    const second = `^XA^FX${"z".repeat(300)}^XZ`;
    const err = (await client
      .send(`^XA^FDone^FS^XZ\n${second}`)
      .catch((e: unknown) => e)) as ZebraError;
    expect(err).toBeInstanceOf(ZebraError);
    expect(err.problem).toBe("send-failed");
    expect(err.printed).toBe(1);
    expect(err.message).toMatch(/couldn't send label 2 of 2\. The first one printed\./);
    // Nothing of the second label got through, so there was nothing to close.
    expect(written(calls).filter((write) => write.data === "^XZ")).toHaveLength(0);
  });

  it("doesn't send anything when Browser Print can't be reached", async () => {
    const { client, calls } = agent(() => "down");
    await expect(client.send("^XA^XZ")).rejects.toMatchObject({ problem: "not-running" });
    expect(calls.some((call) => path(call) === "/write")).toBe(false);
  });
});

const READY = `
  PRINTER STATUS
   ERRORS:         0 00000000 00000000
   WARNINGS:       0 00000000 00000000
`;
const PAUSED_NO_LABELS = `
  PRINTER STATUS
   ERRORS:         1 00000000 00000101
   WARNINGS:       0 00000000 00000000
`;

describe("asking the printer how it is", () => {
  it("reads the printer's own answer", () => {
    expect(parseZebraStatus(READY)).toEqual({ known: true, ok: true, problems: [] });
    expect(parseZebraStatus(PAUSED_NO_LABELS)).toEqual({
      known: true,
      ok: false,
      problems: ["out of labels", "paused"],
    });
    expect(parseZebraStatus("")).toEqual({ known: false, problems: [] });
    expect(parseZebraStatus("something else entirely")).toEqual({ known: false, problems: [] });
  });

  it("clears what was waiting, asks, and reads until the answer is whole", async () => {
    let reads = 0;
    const { client, calls } = agent((call) => {
      if (path(call) === "/read") {
        reads += 1;
        // The first read drops old words; the answer then arrives in two parts.
        return {
          text:
            reads === 1 ? "old" : reads === 2 ? "ERRORS: 1 00000000 00000004" : " WARNINGS: 0 0 0",
        };
      }
      return healthy(call);
    });
    const state = await client.status(ZT as never);
    expect(state).toEqual({ known: true, ok: false, problems: ["print head open"] });
    expect(written(calls).map((write) => write.data)).toEqual(["~HQES"]);
    expect(reads).toBe(3);
  });

  it("says it doesn't know when the printer stays silent", async () => {
    const { client } = agent(healthy);
    expect(await client.status(ZT as never)).toEqual({ known: false, problems: [] });
  });
});

describe("resetting the printer", () => {
  it("cancels what is waiting, closes an open label and resumes, printing nothing", async () => {
    const { client, calls } = agent(healthy);
    const device = await client.reset("ZT220");
    expect(device.name).toBe("ZT220");
    expect(written(calls).map((write) => write.data)).toEqual(["~JA", "^XA^XZ~PS"]);
  });

  it("says so when the printer won't take it", async () => {
    const { client } = agent((call) => (path(call) === "/write" ? { status: 500 } : healthy(call)));
    await expect(client.reset()).rejects.toMatchObject({ problem: "send-failed" });
  });
});

describe("checking the connection", () => {
  it("walks through each step and says all is well", async () => {
    const { client } = agent((call) => (path(call) === "/read" ? { text: READY } : healthy(call)));
    const checks = await client.diagnose();
    expect(checks.every((check) => check.ok)).toBe(true);
    const words = checks.map((check) => check.text).join(" ");
    expect(words).toContain("Browser Print answers at localhost:9101.");
    expect(words).toContain("Printers it can see: ZT220, ZD420 upstairs.");
    expect(words).toContain("Sending to ZT220.");
    expect(words).toContain("The printer says it's ready.");
    expect(words).toContain("Big labels go through in one piece.");
  });

  it("stops at the step that failed when nothing is listening", async () => {
    const { client } = agent(() => "down");
    const checks = await client.diagnose();
    expect(checks.map((check) => check.ok)).toEqual([false, false, false]);
    expect(checks[2].text).toBe(ZEBRA_MESSAGES["not-running"]);
  });

  it("explains the browser's own block, the way Chrome names it", async () => {
    const calls: string[] = [];
    const client = createZebraClient({
      fetch: async (input) => {
        calls.push(input);
        throw new TypeError("Failed to fetch");
      },
      sleep: async () => undefined,
      permission: async () => "denied",
    });
    const checks = await client.diagnose();
    expect(checks[0]).toEqual({ ok: false, text: ZEBRA_MESSAGES.blocked });
    expect(ZEBRA_MESSAGES.blocked).toMatch(/Local network access/);
    expect(ZEBRA_MESSAGES.blocked).toMatch(/Apps on device/);
    expect(ZEBRA_MESSAGES["not-running"]).toMatch(/apps on this computer/);
  });

  it("learns to send in small pieces when Browser Print refuses big requests", async () => {
    const { client, calls } = agent((call) => {
      if (path(call) === "/write") {
        const { data } = JSON.parse(call.body) as { data: string };
        return data.length > 1000 ? { status: 500 } : { text: "" };
      }
      return path(call) === "/read" ? { text: READY } : healthy(call);
    });
    const checks = await client.diagnose();
    expect(checks.at(-1)).toMatchObject({ ok: true });
    expect(checks.at(-1)?.text).toMatch(/small pieces/);
    calls.length = 0;
    // The next label goes out in pieces no bigger than what got through.
    await client.send(`^XA${"A".repeat(3000)}^XZ`);
    const pieces = written(calls).filter((write) => write.data !== "");
    expect(pieces.length).toBeGreaterThan(3);
    expect(Math.max(...pieces.map((piece) => piece.data.length))).toBeLessThanOrEqual(800);
  });
});
