export type ProviderKey = "shopify" | "quickbooks";

export type ConnectionStatus = "active" | "needs_reconnect" | "disconnected";

/** What we keep in Vault for a connection. Never logged, never sent to a browser. */
export type TokenSet = {
  access_token: string;
  refresh_token?: string;
  /** Epoch milliseconds; absent for tokens that don't expire. */
  expires_at?: number;
  refresh_expires_at?: number;
};

export type ConnectedAccount = {
  externalAccountId: string;
  displayName: string;
  scopes: string[];
  token: TokenSet;
  metadata?: Record<string, unknown>;
};

export type ConnectStart = {
  state: string;
  redirectUri: string;
  /** Provider-specific input from the connect form (Shopify's shop domain). */
  input: Record<string, string>;
};

export type ConnectFinish = {
  /** Query parameters the provider sent to our callback. */
  params: URLSearchParams;
  redirectUri: string;
  /** What we stored when the flow started. */
  input: Record<string, string>;
};

export type SyncContext = {
  connectionId: string;
  externalAccountId: string;
  token: TokenSet;
  job: {
    type: "full" | "incremental" | "webhook";
    topic: string | null;
    payload: unknown;
    cursor: unknown;
  };
};

export type SyncResult = {
  cursor?: Record<string, unknown>;
  /** Fresh details to show about the connected account. */
  account?: { displayName?: string; metadata?: Record<string, unknown> };
  /** Set when the provider told us the connection is over (app uninstalled). */
  disconnected?: string;
};

/** A provider said the tokens are no longer good: the owner must reconnect. */
export class ReconnectRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconnectRequiredError";
  }
}

/** The person connecting did something we can explain to them. */
export class ConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectError";
  }
}

/**
 * Every integration implements this (CLAUDE.md rule 9). `connect` is split in
 * two because OAuth leaves our site and comes back.
 */
export interface ProviderAdapter {
  key: ProviderKey;
  name: string;
  blurb: string;
  /** Extra fields the connect form asks for. */
  connectFields: { name: string; label: string; placeholder: string; help?: string }[];
  /** True when this environment has the provider's app credentials. */
  configured(): boolean;
  /** Where to send the person to approve the connection. */
  beginConnect(start: ConnectStart): string;
  /** Exchanges the callback for tokens and identifies the account. */
  completeConnect(finish: ConnectFinish): Promise<ConnectedAccount>;
  /** Runs once after a connection is saved (register webhooks, ...). */
  afterConnect?(account: ConnectedAccount, siteUrl: string): Promise<void>;
  /** Returns new tokens. Throws ReconnectRequiredError when they can't be renewed. */
  refresh(token: TokenSet, externalAccountId: string): Promise<TokenSet>;
  /** Best-effort revoke on the provider's side. */
  disconnect(token: TokenSet, externalAccountId: string): Promise<void>;
  sync(ctx: SyncContext): Promise<SyncResult>;
  /** How often to pull when the provider doesn't push changes. Null = webhook-driven. */
  pollEveryHours: number | null;
}

export type Fetch = typeof fetch;
