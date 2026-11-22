import { isProviderKey } from "./registry";
import type { StoredToken } from "./tokens";
import {
  ReconnectRequiredError,
  type ProviderAdapter,
  type ProviderKey,
  type SyncResult,
  type SyncStore,
} from "./types";

export type SyncJob = {
  id: number;
  tenant_id: string;
  connection_id: string;
  provider: string;
  type: "full" | "incremental" | "webhook";
  topic: string | null;
  payload: unknown;
  cursor: unknown;
  attempts: number;
};

export type RunnerDeps = {
  adapter(provider: ProviderKey): ProviderAdapter;
  getToken(tenantId: string, provider: ProviderKey): Promise<StoredToken>;
  /** Storage for what the sync fetches, scoped to this job's workspace and provider. */
  store(job: SyncJob): SyncStore;
  finish(
    jobId: number,
    outcome: { error?: string; cursor?: object; retry?: boolean },
  ): Promise<void>;
  /** Puts the job back on the queue to carry on from `cursor`. */
  requeue(jobId: number, cursor: object): Promise<void>;
  updateAccount(connectionId: string, account: NonNullable<SyncResult["account"]>): Promise<void>;
  disconnect(connectionId: string, reason: string): Promise<void>;
};

export type JobOutcome = "succeeded" | "continued" | "retry" | "failed" | "disconnected";

/**
 * Runs one sync job. Decides what kind of failure it was:
 *  - the provider says reconnect → fail now (the token layer already flagged
 *    the connection and told the owner)
 *  - anything else → retry with backoff, up to the queue's limit
 */
export async function runSyncJob(job: SyncJob, deps: RunnerDeps): Promise<JobOutcome> {
  if (!isProviderKey(job.provider)) {
    await deps.finish(job.id, { error: `Unknown provider ${job.provider}`, retry: false });
    return "failed";
  }

  try {
    const adapter = deps.adapter(job.provider);
    // Uninstall and privacy notices arrive after the token is already dead.
    const needsToken = !(
      job.type === "webhook" && (adapter.tokenlessTopics ?? []).includes(job.topic ?? "")
    );
    const stored = needsToken ? await deps.getToken(job.tenant_id, job.provider) : null;

    const result = await adapter.sync({
      store: deps.store(job),
      connectionId: job.connection_id,
      externalAccountId: stored?.externalAccountId ?? "",
      token: stored?.token ?? { access_token: "" },
      job: { type: job.type, topic: job.topic, payload: job.payload, cursor: job.cursor },
    });

    if (result.disconnected) {
      // Finish first: disconnecting cancels whatever is still open.
      await deps.finish(job.id, {});
      await deps.disconnect(job.connection_id, result.disconnected);
      return "disconnected";
    }
    if (result.account) await deps.updateAccount(job.connection_id, result.account);
    if (result.continueWith) {
      await deps.requeue(job.id, result.continueWith);
      return "continued";
    }
    await deps.finish(job.id, { cursor: result.cursor });
    return "succeeded";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ReconnectRequiredError) {
      await deps.finish(job.id, { error: message, retry: false });
      return "failed";
    }
    await deps.finish(job.id, { error: message, retry: true });
    return "retry";
  }
}
