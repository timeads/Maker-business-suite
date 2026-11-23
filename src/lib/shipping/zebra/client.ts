/**
 * Talking to Zebra Browser Print: Zebra's free helper that runs on the
 * packing computer itself and passes what a web page sends on to the printer.
 * The browser calls it directly; nothing here goes through our servers.
 *
 * Ported from the single-tenant help desk (`public/js/printing.js`): the same
 * two addresses, the same four calls (`/default`, `/available`, `/write`),
 * the same plain-text request so the browser sends no preflight, and the same
 * habit of sending a label in pieces and retrying a piece that is refused.
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
    "We couldn't reach Zebra Browser Print on this computer. Check that it's installed and running (its icon sits in the system tray or menu bar). If it is, open localhost:9101/ssl_support once in this browser, accept it, and try again.",
  blocked:
    "This browser is stopping the page from talking to Zebra Browser Print. Click the icon at the left of the address bar, open Site settings, set “Local network access” to Allow, then reload this page.",
  "no-printer":
    "Zebra Browser Print is running but can't see a printer. Check the cable and that the printer is switched on, then choose it in Browser Print's own settings.",
} as const;

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
    const order = good ? [good, ...ZEBRA_AGENTS.filter((base) => base !== good)] : [...ZEBRA_AGENTS];
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
      return list.sort(
        (a, b) => Number(b.connection === "usb") - Number(a.connection === "usb"),
      );
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
  async function send(zpl: string, savedName = ""): Promise<{ device: ZebraDevice; labels: number }> {
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
      for (let position = 0; position < job.length; ) {
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
          const before =
            index > 0 ? ` The first ${index === 1 ? "one" : index} printed.` : "";
          throw new ZebraError(
            "send-failed",
            `We found ${device.name} but couldn't send ${which}.${before} Check the printer is on, has labels and isn't paused, then print again.`,
            index,
          );
        }
      }
      // Let the printer take each one.
      if (jobs.length > 1) await sleep(150);
    }
    return { device, labels: jobs.length };
  }

  return { findPrinters, pickPrinter, send };
}

export type ZebraClient = ReturnType<typeof createZebraClient>;
