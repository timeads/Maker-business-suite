import type { ModuleKey } from "@/lib/modules";
import type { Tenant } from "@/lib/tenants";

export type Feature = `module.${ModuleKey}`;

/**
 * The one place feature gates are decided (CLAUDE.md rule 7).
 * Phase 1 ships no modules, so everything is off; Phase 2 reads the
 * tenant's subscription here.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function can(tenant: Pick<Tenant, "id">, feature: Feature): boolean {
  return false;
}
