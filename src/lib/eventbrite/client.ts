import type { Fetch } from "../connections/types";
import type { EventbriteOrder } from "./orders";

/**
 * The one way the suite talks to Eventbrite: plain `fetch` to
 * www.eventbriteapi.com/v3 with the business's own private token (read from
 * Vault through `getEventbriteAccess`, never logged, never put in an error,
 * never returned to a browser). No SDK.
 *
 * Every call here is one the business's earlier booking app made and that
 * worked for it (docs/eventbrite.md says which, and what is ours):
 *   GET  /users/me/organizations/
 *   GET  /organizations/{org}/events/?status=live,started&order_by=start_asc&expand=ticket_classes
 *   GET  /events/{event}/ticket_classes/{ticket_class}/
 *   POST /events/{event}/ticket_classes/{ticket_class}/   (form-encoded, dotted keys)
 *   GET  /orders/{order}/?expand=attendees
 *   GET  /organizations/{org}/webhooks/
 *   POST /organizations/{org}/webhooks/                   (form-encoded)
 *
 * Calls are made one at a time with a short gap between them. Reads are
 * tried again after a busy answer (429, 5xx) or a lost connection; writes
 * never are: how a write went is reported once (`EventbriteError.applied`)
 * and the once-only record decides what happens next.
 */

export const EVENTBRITE_API = "https://www.eventbriteapi.com/v3";
/** Eventbrite's ids are long runs of digits; only those go into an address. */
export const EVENTBRITE_ID = /^[0-9]{1,30}$/;

export type EventbriteAccess = {
  /** Our id for the connection; the throttle is kept per client. */
  connectionId: string;
  token: string;
  /** The organization the token was connected for. */
  organizationId: string;
};

/**
 * Whether a write might have taken effect:
 *   no      Eventbrite answered and said no (4xx): nothing changed.
 *   unknown we never got a clear answer (5xx, timeout, lost connection).
 */
export type Applied = "no" | "unknown";

export class EventbriteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Eventbrite's own short code ("NOT_FOUND", "INVALID_AUTH"), when it gave one. */
    readonly code: string,
    /** Eventbrite's words, cut short; never anything of ours that is secret. */
    readonly words: string,
    readonly applied: Applied,
  ) {
    super(message);
    this.name = "EventbriteError";
  }

  /** The token is wrong, revoked or not allowed this. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export type EventbriteOrganization = { id: string; name: string };
export type EventbriteTicketClass = {
  id: string;
  name: string;
  quantityTotal: number;
  quantitySold: number;
  hidden: boolean;
};
export type EventbriteEvent = {
  id: string;
  name: string;
  /** ISO time in UTC, as Eventbrite gives `start.utc`. */
  startUtc: string | null;
  ticketClasses: { id: string; name: string }[];
};
export type EventbriteWebhook = { id: string; endpointUrl: string };

export type TicketClassChange = { quantity_total?: number; hidden?: boolean };

export interface EventbriteClientOptions {
  fetchImpl?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum gap between calls (default 250ms). */
  minIntervalMs?: number;
  timeoutMs?: number;
  /** How many more times a read is tried after a busy answer (default 3). */
  maxRetries?: number;
}

export interface EventbriteClient {
  organizations(): Promise<EventbriteOrganization[]>;
  listEvents(organizationId: string): Promise<EventbriteEvent[]>;
  getTicketClass(eventId: string, ticketClassId: string): Promise<EventbriteTicketClass>;
  updateTicketClass(
    eventId: string,
    ticketClassId: string,
    change: TicketClassChange,
  ): Promise<void>;
  getOrder(orderId: string): Promise<EventbriteOrder>;
  listWebhooks(organizationId: string): Promise<EventbriteWebhook[]>;
  createWebhook(organizationId: string, endpointUrl: string, actions: string): Promise<string>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Most pages of events read for the picker. */
const MAX_EVENT_PAGES = 5;

function id(value: string, what: string): string {
  if (!EVENTBRITE_ID.test(value)) throw new Error(`That isn't an Eventbrite ${what} id`);
  return value;
}

const text = (value: unknown, max = 200) =>
  (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim().slice(0, max);

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/** What Eventbrite said, in a line: its description, else its short code. */
function wordsOf(body: unknown): { code: string; words: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return { code: text(b.error, 60), words: text(b.error_description) || text(b.error, 60) };
}

export function createEventbriteClient(
  access: Pick<EventbriteAccess, "token">,
  opts: EventbriteClientOptions = {},
): EventbriteClient {
  const doFetch: Fetch = (input, init) => (opts.fetchImpl ?? globalThis.fetch)(input, init);
  const sleep = opts.sleep ?? defaultSleep;
  const minInterval = opts.minIntervalMs ?? 250;
  const maxRetries = opts.maxRetries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  let queue: Promise<unknown> = Promise.resolve();
  let lastCallAt = 0;

  type Once = { ok: true; body: unknown } | { ok: false; error: EventbriteError; busy: boolean };

  async function once(method: "GET" | "POST", path: string, form?: URLSearchParams): Promise<Once> {
    const wait = lastCallAt + minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const where = `${method} ${path.split("?")[0]}`;
    let res: Response;
    try {
      res = await doFetch(`${EVENTBRITE_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${access.token}`,
          Accept: "application/json",
          ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: form?.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      // Our own words only: a network error's message is not ours to trust.
      const words = timedOut ? "Eventbrite didn't answer in time" : "We couldn't reach Eventbrite";
      return {
        ok: false,
        error: new EventbriteError(`Eventbrite ${where}: ${words}`, 0, "NETWORK", words, "unknown"),
        busy: true,
      };
    }
    const raw = await res.text();
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    if (res.ok) return { ok: true, body };
    const { code, words } = wordsOf(body);
    const busy = res.status === 429 || res.status >= 500;
    return {
      ok: false,
      error: new EventbriteError(
        `Eventbrite ${where}: ${res.status}${words ? ` (${words})` : ""}`,
        res.status,
        code,
        words || `Eventbrite answered ${res.status}`,
        // A 4xx is a clear no; a 5xx may have done part of the work.
        res.status >= 500 ? "unknown" : "no",
      ),
      busy,
    };
  }

  async function read(path: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const result = await once("GET", path);
      if (result.ok) return result.body;
      if (!result.busy || attempt >= maxRetries) throw result.error;
      await sleep(Math.min(8_000, 1000 * 2 ** attempt));
    }
  }

  async function write(path: string, form: URLSearchParams): Promise<unknown> {
    const result = await once("POST", path, form);
    if (result.ok) return result.body;
    throw result.error;
  }

  // One call at a time, whoever asks.
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const p = queue.then(task);
    queue = p.catch(() => undefined);
    return p;
  }

  return {
    organizations: () =>
      serial(async () => {
        const body = (await read("/users/me/organizations/")) as { organizations?: unknown[] };
        return (Array.isArray(body?.organizations) ? body.organizations : [])
          .map((o) => o as { id?: unknown; name?: unknown })
          .filter((o) => EVENTBRITE_ID.test(String(o.id ?? "")))
          .map((o) => ({ id: String(o.id), name: text(o.name, 120) || "Eventbrite" }));
      }),

    listEvents: (organizationId) =>
      serial(async () => {
        const org = id(organizationId, "organization");
        const events: EventbriteEvent[] = [];
        let continuation = "";
        for (let page = 0; page < MAX_EVENT_PAGES; page++) {
          const query = new URLSearchParams({
            status: "live,started",
            order_by: "start_asc",
            expand: "ticket_classes",
          });
          if (continuation) query.set("continuation", continuation);
          const body = (await read(`/organizations/${org}/events/?${query.toString()}`)) as {
            events?: unknown[];
            pagination?: { has_more_items?: unknown; continuation?: unknown };
          };
          for (const raw of Array.isArray(body?.events) ? body.events : []) {
            const e = raw as {
              id?: unknown;
              name?: { text?: unknown };
              start?: { utc?: unknown };
              ticket_classes?: unknown[];
            };
            if (!EVENTBRITE_ID.test(String(e.id ?? ""))) continue;
            events.push({
              id: String(e.id),
              name: text(e.name?.text) || "(untitled)",
              startUtc: typeof e.start?.utc === "string" ? e.start.utc : null,
              ticketClasses: (Array.isArray(e.ticket_classes) ? e.ticket_classes : [])
                .map((t) => t as { id?: unknown; name?: unknown })
                .filter((t) => EVENTBRITE_ID.test(String(t.id ?? "")))
                .map((t) => ({ id: String(t.id), name: text(t.name, 120) || "Ticket" })),
            });
          }
          const next = body?.pagination;
          if (next?.has_more_items !== true || typeof next.continuation !== "string") break;
          continuation = next.continuation;
        }
        return events;
      }),

    getTicketClass: (eventId, ticketClassId) =>
      serial(async () => {
        const body = (await read(
          `/events/${id(eventId, "event")}/ticket_classes/${id(ticketClassId, "ticket")}/`,
        )) as Record<string, unknown>;
        return {
          id: ticketClassId,
          name: text(body?.name, 120),
          quantityTotal: num(body?.quantity_total),
          quantitySold: num(body?.quantity_sold),
          hidden: body?.hidden === true,
        };
      }),

    updateTicketClass: (eventId, ticketClassId, change) =>
      serial(async () => {
        // Eventbrite takes this form-encoded with dotted keys, not as JSON:
        // the earlier app's working call.
        const form = new URLSearchParams();
        if (change.quantity_total !== undefined) {
          form.set(
            "ticket_class.quantity_total",
            String(Math.max(0, Math.trunc(change.quantity_total))),
          );
        }
        if (change.hidden !== undefined) form.set("ticket_class.hidden", String(change.hidden));
        if ([...form.keys()].length === 0) return;
        await write(
          `/events/${id(eventId, "event")}/ticket_classes/${id(ticketClassId, "ticket")}/`,
          form,
        );
      }),

    getOrder: (orderId) =>
      serial(
        async () =>
          (await read(`/orders/${id(orderId, "order")}/?expand=attendees`)) as EventbriteOrder,
      ),

    listWebhooks: (organizationId) =>
      serial(async () => {
        const body = (await read(
          `/organizations/${id(organizationId, "organization")}/webhooks/`,
        )) as {
          webhooks?: unknown[];
        };
        return (Array.isArray(body?.webhooks) ? body.webhooks : [])
          .map((w) => w as { id?: unknown; endpoint_url?: unknown })
          .map((w) => ({
            id: String(w.id ?? ""),
            endpointUrl: typeof w.endpoint_url === "string" ? w.endpoint_url : "",
          }));
      }),

    createWebhook: (organizationId, endpointUrl, actions) =>
      serial(async () => {
        const form = new URLSearchParams({ endpoint_url: endpointUrl, actions });
        const body = (await write(
          `/organizations/${id(organizationId, "organization")}/webhooks/`,
          form,
        )) as { id?: unknown };
        return EVENTBRITE_ID.test(String(body?.id ?? "")) ? String(body?.id) : "";
      }),
  };
}
