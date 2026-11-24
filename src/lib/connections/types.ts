export type ProviderKey =
  "shopify" | "quickbooks" | "stripe" | "meta" | "easypost" | "ups" | "redo";

export type ConnectionStatus = "active" | "needs_reconnect" | "disconnected";

/** What we keep in Vault for a connection. Never logged, never sent to a browser. */
export type TokenSet = {
  access_token: string;
  refresh_token?: string;
  /** Epoch milliseconds; absent for tokens that don't expire. */
  expires_at?: number;
  refresh_expires_at?: number;
  /**
   * For a connection made of several typed-in keys (UPS's client id, secret
   * and account number): the parts beside the token, by name. Kept in Vault
   * with the rest, and just as secret.
   */
  secrets?: Record<string, string>;
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

export type CustomerRow = {
  external_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  source_created_at: string | null;
  source_updated_at: string | null;
};

export type ProductRow = {
  external_id: string;
  title: string;
  vendor: string | null;
  product_type: string | null;
  status: string | null;
  source_updated_at: string | null;
};

export type OrderLineRow = {
  external_id: string;
  product_external_id: string | null;
  title: string;
  variant_title: string | null;
  sku: string | null;
  quantity: number;
  unit_price: number;
  unit_cost: number | null;
};

export type OrderRow = {
  external_id: string;
  name: string | null;
  customer_external_id: string | null;
  email: string | null;
  processed_at: string;
  currency: string | null;
  net_sales: number;
  total_tax: number;
  total_shipping: number;
  total: number;
  /** The products before discounts, and the discounts, when the shop gives them. */
  gross_sales?: number | null;
  total_discounts?: number | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  channel: string;
  cancelled_at: string | null;
  is_test: boolean;
  source_updated_at: string | null;
  lines: OrderLineRow[];
};

export type SnapshotRow = {
  kind: "profit_and_loss" | "balance_sheet" | "ar_aging";
  period_start: string;
  period_end: string;
  data: Record<string, unknown>;
};

/** One thing the shop keeps a count of (a product, or one option of it). */
export type StockItemRow = {
  external_id: string;
  product_external_id: string | null;
  inventory_item_id: string | null;
  title: string;
  variant_title: string | null;
  sku: string | null;
  on_hand: number;
  unit_cost: number | null;
  tracked: boolean;
  product_status: string | null;
  /** Who the shop says it comes from; becomes a supplier. */
  vendor: string | null;
  price: number | null;
};

export type ProductPhotoRow = {
  product_external_id: string;
  image_url: string | null;
  product_url: string | null;
};

/** What packing an order needs: who it's for and what is left to send. */
export type ShippingOrderRow = {
  external_id: string;
  recipient: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  phone: string | null;
  /** The option the shopper picked at checkout. */
  shipping_method: string | null;
  /** What they paid for it. */
  shipping_paid: number | null;
  weight_grams: number | null;
  /** They're collecting it, so there's nothing to post. */
  pickup: boolean;
  note: string | null;
  paid: boolean;
  /** The shop's own tags on the order. */
  tags?: string[] | null;
  items: {
    line_id: string;
    title: string;
    variant: string | null;
    sku: string | null;
    barcode: string | null;
    /** What one of them cost the shopper. */
    price: number | null;
    /** A small picture of the option that was ordered, on the shop's image servers. */
    image?: string | null;
    qty: number;
    left: number;
  }[];
};

/**
 * A shop order that carries workshop dates: each line names the date it is
 * for (the date picker on the product page put it there).
 */
export type ShopBookingOrder = {
  external_id: string;
  /** The order number as the shopper sees it, e.g. #1042. */
  name: string;
  cancelled: boolean;
  customer_name: string;
  email: string | null;
  lines: { session_id: string; seats: number; amount_cents: number }[];
};

/** Where a sync puts what it fetched. Always scoped to the job's workspace and provider. */
export type SyncStore = {
  upsertCommerce(batch: {
    customers?: CustomerRow[];
    products?: ProductRow[];
    orders?: OrderRow[];
  }): Promise<void>;
  upsertStock(items: StockItemRow[]): Promise<void>;
  /** Each product's main photo and its page in the shop. */
  setProductPhotos(products: ProductPhotoRow[]): Promise<void>;
  /** Turns orders with workshop dates on them into bookings. Safe to repeat. */
  bookShopOrders(orders: ShopBookingOrder[]): Promise<void>;
  /** For orders already stored with upsertCommerce. */
  upsertShipping(orders: ShippingOrderRow[]): Promise<void>;
  saveSnapshots(rows: SnapshotRow[]): Promise<void>;
  /** Erases one shopper's personal details, keeping the sales figures. */
  redactCustomer(externalId: string, email: string | null): Promise<void>;
  /** Deletes everything synced from this provider for the workspace. */
  purgeProviderData(): Promise<void>;
  /** Counts API calls made, for usage limits. */
  recordUsage(calls: number): Promise<void>;
  notifyOwners(subject: string, text: string): Promise<void>;
};

export type SyncContext = {
  store: SyncStore;
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
  /** Set when there is more to fetch: the job is re-queued with this cursor. */
  continueWith?: Record<string, unknown>;
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
  connectFields: {
    name: string;
    label: string;
    placeholder: string;
    help?: string;
    /** Typed into a password box: an API key, never shown again. */
    secret?: boolean;
    /** A short list to pick from instead of a box to type in; the first is the usual choice. */
    options?: { value: string; label: string }[];
  }[];
  /** True when this environment has the provider's app credentials. */
  configured(): boolean;
  /** Where to send the person to approve the connection. */
  beginConnect(start: ConnectStart): string;
  /** Exchanges the callback for tokens and identifies the account. */
  completeConnect(finish: ConnectFinish): Promise<ConnectedAccount>;
  /**
   * For providers that connect with a pasted API key rather than by sending
   * the person away to approve: checks the key and identifies the account in
   * one step. The key comes back as the token, so it is stored in Vault like
   * any other. When this is present, `beginConnect` is never used.
   */
  connectWithKey?(input: Record<string, string>): Promise<ConnectedAccount>;
  /** Runs once after a connection is saved (register webhooks, ...). */
  afterConnect?(account: ConnectedAccount, siteUrl: string): Promise<void>;
  /** Returns new tokens. Throws ReconnectRequiredError when they can't be renewed. */
  refresh(token: TokenSet, externalAccountId: string): Promise<TokenSet>;
  /** Best-effort revoke on the provider's side. */
  disconnect(token: TokenSet, externalAccountId: string): Promise<void>;
  sync(ctx: SyncContext): Promise<SyncResult>;
  /** Webhook topics that are handled without a token (it may already be dead). */
  tokenlessTopics?: readonly string[];
  /** How often to pull when the provider doesn't push changes. Null = webhook-driven. */
  pollEveryHours: number | null;
}

export type Fetch = typeof fetch;
