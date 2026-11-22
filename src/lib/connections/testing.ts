import type { CustomerRow, OrderRow, ProductRow, SnapshotRow, SyncStore } from "./types";

/** An in-memory SyncStore for tests: records everything a sync wrote. */
export function memoryStore() {
  const state = {
    customers: [] as CustomerRow[],
    products: [] as ProductRow[],
    orders: [] as OrderRow[],
    snapshots: [] as SnapshotRow[],
    redacted: [] as { externalId: string; email: string | null }[],
    purged: 0,
    usage: 0,
    notices: [] as { subject: string; text: string }[],
  };
  const store: SyncStore = {
    async upsertCommerce(batch) {
      state.customers.push(...(batch.customers ?? []));
      state.products.push(...(batch.products ?? []));
      state.orders.push(...(batch.orders ?? []));
    },
    async saveSnapshots(rows) {
      state.snapshots.push(...rows);
    },
    async redactCustomer(externalId, email) {
      state.redacted.push({ externalId, email });
    },
    async purgeProviderData() {
      state.purged += 1;
    },
    async recordUsage(calls) {
      state.usage += calls;
    },
    async notifyOwners(subject, text) {
      state.notices.push({ subject, text });
    },
  };
  return { store, state };
}
