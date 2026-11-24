/**
 * Talking to Zebra Browser Print: Zebra's free helper that runs on the
 * packing computer itself and passes what a web page sends on to the printer.
 * The browser calls it directly; nothing here goes through our servers.
 *
 * Ported from the single-tenant help desk (`public/js/printing.js`): the same
 * two addresses, the same calls (`/default`, `/available`, `/write`, `/read`),
 * the same plain-text request so the browser sends no preflight, the same
 * habit of sending a label in pieces and retrying a piece that is refused,
 * and the same ways of asking the printer how it is and clearing a stuck job.
 *
 * Nothing here runs by itself: a browser may ask the person before a page
 * talks to apps on their computer, so every call follows a person's press.
 */

/** Browser Print listens here on the computer it is installed on. */
export const ZEBRA_AGENTS = ["https://localhost:9101", "http://localhost:9100"] as const;

/** Opened once per browser so it accepts Browser Print's own certificate. */
export const ZEBRA_TRUST_LINK = "https://localhost:9101/ssl_support";
export const ZEBRA_DOWNLOAD_LINK =
  "https://www.zebra.com/us/en/support-downloads/software/printer-software/browser-print.html";

/** A printer as Browser Print describes it. Sent back to it whole, exactly as given. */
export type ZebraDevice = Record<string, unknown> & { uid: string; name: string };

export type ZebraProblem = "not-running" | "blocked" | "no-printer" | "send-failed";

/** `message` is written for the person at the packing bench. */
export class ZebraError extends Error {
  constructor(
    public problem: ZebraProblem,
    message: string,
    /** How many whole labels went out before it stopped. */
    public printed = 0,
  ) {
    super(message);
    this.name = "ZebraError";
  }
}

export const ZEBRA_MESSAGES = {
  "not-running":
    "We couldn't reach Zebra Browser Print on this computer. Either it isn't installed and running (its icon sits in the system tray or menu bar), or the browser is stopping this site from talking to apps on this computer. If Chrome asked whether this site may reach devices or apps on this computer, choose Allow. If Browser Print is running, open localhost:9101/ssl_support once in this browser, accept it, and try again.",
  blocked:
    "Chrome is blocking this site from talking to Zebra Browser Print. Click the icon at the left of the address bar, open Site settings, set “Local network access” (or “Apps on device”) to Allow, then reload this page.",
  "no-printer":
    "Zebra Browser Print is running but can't see a printer. Check the cable and that the printer is switched on, then choose it in Browser Print's own settings.",
} as const;

/** What the printer says about itself, in words for the bench. */
export type ZebraStatus =
  { known: true; ok: boolean; problems: string[] } | { known: false; problems: [] };

const STATUS_ERRORS: [number, string][] = [
  [0x1, "out of labels"],
  [0x2, "out of ribbon"],
  [0x4, "print head open"],
  [0x8, "cutter jam"],
  [0x10, "print head too hot"],
  [0x20, "motor too hot"],
  [0x40, "a print head element has failed"],
  [0x80, "print head not found"],
  [0x100, "paused"],
];

/** Reads a Zebra's answer to `~HQES` (its errors and warnings as hex flags). */
export function parseZebraStatus(text: string): ZebraStatus {
  const match = /ERRORS:\s+(\d)\s+(\w+)\s+(\w+)[\s\S]*?WARNINGS:\s+(\d)\s+(\w+)\s+(\w+)/.exec(text);
  if (!match) return { known: false, problems: [] };
  const flags = parseInt(match[3], 16);
  const problems =
    match[1] === "1" && Number.isFinite(flags)
      ? STATUS_ERRORS.filter(([bit]) => flags & bit).map(([, words]) => words)
      : [];
  return { known: true, ok: problems.length === 0, problems };
}

/** One line of "Check the connection": what was looked at and how it went. */
export type ZebraCheck = { ok: boolean; text: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ZebraDeps = {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Whether the browser lets this site reach apps on this computer: "granted", "prompt", "denied" or null. */
  permission?: () => Promise<string | null>;
};

const usable = (device: unknown): device is ZebraDevice =>
  Boolean(
    device &&
    typeof device === "object" &&
    typeof (device as ZebraDevice).uid === "string" &&
    (device as ZebraDevice).uid &&
    typeof (device as ZebraDevice).name === "string" &&
    (device as ZebraDevice).name,
  );

/** Newer Chrome asks before a website may talk to apps on this computer. */
export async function appAccessPermission(): Promise<string | null> {
  if (typeof navigator === "undefined" || !navigator.permissions) return null;
  for (const name of ["loopback-network", "local-network-access", "local-network"]) {
    try {
      const status = await navigator.permissions.query({ name: name as PermissionName });
      return status.state;
    } catch {
      // This browser doesn't know that permission name.
    }
  }
  return null;
}

/** Each label on its own: a big job in one request can be refused. */
export const splitLabels = (zpl: string): string[] => zpl.match(/\^XA[\s\S]*?\^XZ/g) ?? [zpl];

const FIRST_PIECE = 4000;
const SMALLEST_PIECE = 512;

export function createZebraClient(deps: ZebraDeps = {}) {
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const permission = deps.permission ?? appAccessPermission;
  /** The address that answered last time, tried first. */
  let good: string | null = null;
  /** Shrinks for this page if Browser Print refuses pieces. */
  let pieceSize = FIRST_PIECE;

  async function agent(path: string, init?: RequestInit): Promise<Response> {
    const order = good
      ? [good, ...ZEBRA_AGENTS.filter((base) => base !== good)]
      : [...ZEBRA_AGENTS];
    let answered: number | null = null;
    for (const base of order) {
      try {
        const response = await fetchImpl(base + path, init);
        if (response.ok) {
          good = base;
          return response;
        }
        answered = response.status;
      } catch {
        // Not listening at this address, or the browser wouldn't connect.
      }
    }
    throw Object.assign(new Error("Browser Print did not take the request"), { answered });
  }

  async function unreachable(): Promise<ZebraError> {
    const denied = (await permission().catch(() => null)) === "denied";
    return denied
      ? new ZebraError("blocked", ZEBRA_MESSAGES.blocked)
      : new ZebraError("not-running", ZEBRA_MESSAGES["not-running"]);
  }

  /** The printer Browser Print calls its default, or null when it has none (or half of one). */
  async function defaultPrinter(): Promise<ZebraDevice | null> {
    let response: Response;
    try {
      response = await agent("/default?type=printer");
    } catch {
      throw await unreachable();
    }
    const text = await response.text();
    try {
      const device: unknown = text.trim() ? JSON.parse(text) : null;
      return usable(device) ? device : null;
    } catch {
      return null;
    }
  }

  /** The printers Browser Print can see, USB first. Empty when it can't list them. */
  async function available(): Promise<ZebraDevice[]> {
    try {
      const response = await agent("/available");
      const body = (await response.json()) as { printer?: unknown } | null;
      const list = (Array.isArray(body?.printer) ? body.printer : []).filter(usable);
      return list.sort((a, b) => Number(b.connection === "usb") - Number(a.connection === "usb"));
    } catch {
      return [];
    }
  }

  /**
   * Every printer on offer: Browser Print's default first, then the others it
   * can see. Throws when Browser Print can't be reached at all, or sees none.
   */
  async function findPrinters(): Promise<ZebraDevice[]> {
    const first = await defaultPrinter();
    const rest = await available();
    const all = [...(first ? [first] : []), ...rest.filter((device) => device.uid !== first?.uid)];
    if (all.length === 0) throw new ZebraError("no-printer", ZEBRA_MESSAGES["no-printer"]);
    return all;
  }

  /**
   * The printer to send to: the one picked on this computer when Browser
   * Print still offers it, else its default, else the first it can see.
   */
  async function pickPrinter(savedName = ""): Promise<ZebraDevice> {
    const all = await findPrinters();
    return all.find((device) => savedName && device.name === savedName) ?? all[0];
  }

  // text/plain keeps this a "simple" request (no preflight), as Zebra's own library does.
  const write = (device: ZebraDevice, data: string) =>
    agent("/write", {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ device, data }),
    });

  /**
   * Sends ZPL to the printer one label at a time, each in pieces the printer
   * joins up. A refused piece is tried again in smaller pieces before giving
   * up; a label left half-sent is closed so the next one prints cleanly.
   */
  async function send(
    zpl: string,
    savedName = "",
  ): Promise<{ device: ZebraDevice; labels: number }> {
    let device = await pickPrinter(savedName);
    // If the chosen printer won't take anything, use another one Browser Print can see.
    try {
      await write(device, "");
    } catch {
      const others = (await available()).filter((other) => other.uid !== device.uid);
      if (others[0]) device = others[0];
    }
    const jobs = splitLabels(zpl);
    for (const [index, job] of jobs.entries()) {
      let size = pieceSize;
      for (let position = 0; position < job.length;) {
        const piece = job.slice(position, position + size);
        try {
          await write(device, piece);
          position += piece.length;
        } catch {
          if (size > SMALLEST_PIECE) {
            size = Math.max(SMALLEST_PIECE, Math.floor(size / 4));
            pieceSize = size;
            await sleep(300);
            continue;
          }
          try {
            await write(device, piece);
            position += piece.length;
            continue;
          } catch {
            // Give up below.
          }
          if (position > 0) await write(device, "^XZ").catch(() => undefined);
          const which = jobs.length > 1 ? `label ${index + 1} of ${jobs.length}` : "the label";
          const before = index > 0 ? ` The first ${index === 1 ? "one" : index} printed.` : "";
          throw new ZebraError(
            "send-failed",
            `We found ${device.name} but couldn't send ${which}.${before} Check the printer is on, has labels and isn't paused, then print again. If it stays stuck, press “Reset printer” in Shipping settings.`,
            index,
          );
        }
      }
      // Let the printer take each one.
      if (jobs.length > 1) await sleep(150);
    }
    return { device, labels: jobs.length };
  }

  const read = async (device: ZebraDevice) =>
    (
      await agent("/read", {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ device }),
      })
    ).text();

  /** Asks the printer how it is (`~HQES`): paused, head open, out of labels. */
  async function status(device: ZebraDevice): Promise<ZebraStatus> {
    // Drop anything old waiting to be read.
    await read(device).catch(() => "");
    await write(device, "~HQES");
    let text = "";
    for (let tries = 0; tries < 6 && !/WARNINGS/.test(text); tries++) {
      await sleep(250);
      text += await read(device).catch(() => "");
    }
    return parseZebraStatus(text);
  }

  /** Clears stuck or half-sent jobs and takes the printer out of pause. Prints nothing. */
  async function reset(savedName = ""): Promise<ZebraDevice> {
    const device = await pickPrinter(savedName);
    try {
      // Cancel everything waiting in the printer, then close any open label and resume.
      await write(device, "~JA");
      await sleep(300);
      await write(device, "^XA^XZ~PS");
    } catch {
      throw new ZebraError(
        "send-failed",
        `We found ${device.name} but it didn't take the reset. Switch the printer off and on, then try again.`,
      );
    }
    return device;
  }

  /**
   * "Check the connection": each step on its own, so a failure says where it
   * is. The last step also learns how big a request Browser Print takes
   * (comments only, so nothing prints) and sends in pieces that size from then on.
   */
  async function diagnose(savedName = ""): Promise<ZebraCheck[]> {
    const out: ZebraCheck[] = [];
    const allowed = await permission().catch(() => null);
    if (allowed) {
      out.push(
        allowed === "denied"
          ? { ok: false, text: ZEBRA_MESSAGES.blocked }
          : {
              ok: true,
              text:
                allowed === "granted"
                  ? "Chrome lets this site reach apps on this computer."
                  : "Chrome will ask whether this site may reach apps on this computer: choose Allow.",
            },
      );
    }
    for (const base of ZEBRA_AGENTS) {
      const where = base.replace(/^https?:\/\//, "");
      try {
        const response = await fetchImpl(`${base}/default?type=printer`);
        out.push({
          ok: response.ok,
          text: response.ok
            ? `Browser Print answers at ${where}.`
            : `Browser Print at ${where} answered ${response.status}.`,
        });
      } catch {
        out.push({
          ok: false,
          text: `Nothing answered at ${where}: Browser Print isn't running, or the browser wouldn't connect.`,
        });
      }
    }
    let device: ZebraDevice;
    try {
      const all = await findPrinters();
      device = all.find((each) => savedName && each.name === savedName) ?? all[0];
      try {
        await write(device, "");
      } catch {
        device = all.find((each) => each.uid !== device.uid) ?? device;
      }
      out.push({
        ok: true,
        text: `Printers it can see: ${all.map((each) => each.name).join(", ")}.`,
      });
      out.push({ ok: true, text: `Sending to ${device.name}.` });
    } catch (err) {
      out.push({
        ok: false,
        text: err instanceof ZebraError ? err.message : "We couldn't look for printers.",
      });
      return out;
    }
    try {
      const state = await status(device);
      out.push(
        !state.known
          ? { ok: true, text: "The printer didn't say how it is (some models don't)." }
          : state.ok
            ? { ok: true, text: "The printer says it's ready." }
            : { ok: false, text: `The printer says: ${state.problems.join(", ")}.` },
      );
    } catch {
      out.push({ ok: false, text: "We couldn't ask the printer how it is." });
    }
    const sizes = [100, 1000, 4000, 16000];
    let passed = 0;
    for (const size of sizes) {
      try {
        await write(device, `^XA^FX${"x".repeat(Math.max(0, size - 12))}^FS^XZ`);
        passed = size;
      } catch {
        break;
      }
    }
    if (passed === sizes[sizes.length - 1]) {
      out.push({ ok: true, text: "Big labels go through in one piece." });
    } else if (passed > 0) {
      pieceSize = Math.max(SMALLEST_PIECE, passed - 200);
      out.push({
        ok: true,
        text: `Browser Print takes small requests only, so labels and slips will be sent in small pieces. That's fine, just a little slower.`,
      });
    } else {
      out.push({ ok: false, text: "The printer was found but took nothing we sent." });
    }
    return out;
  }

  return { findPrinters, pickPrinter, send, status, reset, diagnose };
}

export type ZebraClient = ReturnType<typeof createZebraClient>;

let shared: ZebraClient | null = null;

/**
 * The one client a page uses. It remembers which address answered and how
 * big a piece Browser Print takes, so the second label is as quick as the
 * first was slow.
 */
export function zebraClient(): ZebraClient {
  shared ??= createZebraClient();
  return shared;
}
