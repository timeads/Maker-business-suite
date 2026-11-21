import type { Fetch } from "./types";

/** A provider answered with an error status. `body` is trimmed and never includes our credentials. */
export class ProviderHttpError extends Error {
  constructor(
    public provider: string,
    public status: number,
    public body: string,
  ) {
    super(`${provider} answered ${status}`);
    this.name = "ProviderHttpError";
  }
}

/** fetch + JSON with a timeout, turning error statuses into ProviderHttpError. */
export async function requestJson<T>(
  fetchImpl: Fetch,
  provider: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  if (!response.ok) {
    throw new ProviderHttpError(provider, response.status, text.slice(0, 300));
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderHttpError(provider, response.status, "Response was not JSON");
  }
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return value;
}
