import { describeConfig, findConfig } from "@/lib/assistant/registry";
import type { createClient } from "@/lib/supabase/server";

export type ProposalPreview = {
  id: string;
  /** A setting (`config_proposals`) or a Money action (`action_proposals`). */
  source: "config" | "action";
  name: string;
  summary: string;
  before: string[];
  after: string[];
};

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Before and after, in plain lines, for a proposal the member can see. */
export async function previewProposal(
  supabase: Supabase,
  tenantId: string,
  proposal: { id: string; module: string; key: string; body: unknown; summary: string },
): Promise<ProposalPreview | null> {
  const entry = findConfig(proposal.module, proposal.key);
  if (!entry) return null;
  const { data } = await supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", tenantId)
    .eq("module", entry.module)
    .eq("key", entry.key)
    .maybeSingle();
  return {
    id: proposal.id,
    source: "config",
    name: entry.name,
    summary: proposal.summary,
    before: describeConfig(entry, data?.body),
    after: describeConfig(entry, proposal.body),
  };
}
