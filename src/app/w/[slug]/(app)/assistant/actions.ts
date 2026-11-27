"use server";

import { revalidatePath } from "next/cache";
import { AI_EXHAUSTED, getAiUsage, usageState, type AiUsage } from "@/lib/ai/usage";
import { applyAction, previewAction } from "@/lib/assistant/action-proposals";
import { runAssistant, type ChatTurn } from "@/lib/assistant/run";
import { requireUser } from "@/lib/auth";
import { localDay } from "@/lib/bookings/slots";
import { getEntitlements } from "@/lib/entitlements";
import type { ModuleKey } from "@/lib/modules";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { previewProposal, type ProposalPreview } from "./preview";

export type AssistantResult = {
  error?: string;
  reply?: string;
  proposals?: ProposalPreview[];
  usage?: AiUsage["state"];
};

const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/assistant`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: "Workspace not found." } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  return {
    tenant: ctx.tenant,
    role: ctx.role,
    entitlements,
    supabase: await createClient(),
  } as const;
}

/** One turn of the conversation. The assistant can look things up and file proposals; nothing more. */
export async function askAssistant(
  slug: string,
  history: ChatTurn[],
  message: string,
): Promise<AssistantResult> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_SECRET_KEY) {
    return { error: "The assistant isn't switched on for this environment yet." };
  }
  const text = message.trim().slice(0, 4000);
  if (!text) return { error: "Type a question or a request first." };
  const safeHistory = (Array.isArray(history) ? history : [])
    .filter(
      (turn): turn is ChatTurn =>
        (turn?.role === "user" || turn?.role === "assistant") && typeof turn.text === "string",
    )
    .slice(-12);

  const limit = ctx.entitlements.limit("ai_credits");
  const before = await getAiUsage(ctx.supabase, ctx.tenant.id, limit);
  if (before.state === "exhausted") return { error: AI_EXHAUSTED, usage: "exhausted" };

  try {
    const reply = await runAssistant(
      {
        history: safeHistory,
        message: text,
        today: localDay(new Date(), ctx.tenant.timezone),
        workspaceName: ctx.tenant.name,
      },
      {
        supabase: ctx.supabase,
        tenant: ctx.tenant,
        can: (module: ModuleKey) => ctx.entitlements.can(`module.${module}`),
        manager: canManage(ctx.role),
      },
    );
    // Metered whatever came back: the tokens were spent.
    const { error: usageError } = await getAdminClient().rpc("record_usage", {
      p_tenant_id: ctx.tenant.id,
      p_type: "ai_tokens",
      p_quantity: reply.tokens,
    });
    if (usageError) console.error(`Could not record AI usage: ${usageError.message}`);
    const usage = usageState(before.used + reply.tokens, limit);

    if (reply.outcome === "declined") {
      return { error: "The assistant couldn't help with that one. Try asking another way.", usage };
    }
    const proposals: ProposalPreview[] = [];
    for (const filed of reply.proposals) {
      if (filed.source === "action") {
        const { data: row } = await ctx.supabase
          .from("action_proposals")
          .select("id, kind, target, body, summary")
          .eq("id", filed.id)
          .eq("tenant_id", ctx.tenant.id)
          .maybeSingle();
        const preview = row ? await previewAction(ctx.supabase, ctx.tenant, row) : null;
        if (preview) proposals.push(preview);
        continue;
      }
      const { data } = await ctx.supabase
        .from("config_proposals")
        .select("id, module, key, body, summary")
        .eq("id", filed.id)
        .eq("tenant_id", ctx.tenant.id)
        .maybeSingle();
      const preview = data ? await previewProposal(ctx.supabase, ctx.tenant.id, data) : null;
      if (preview) proposals.push(preview);
    }
    return {
      reply:
        reply.text ||
        (proposals.length
          ? "I've put together a suggestion for you to look over."
          : "I ran out of steps before finishing. Could you ask again, a bit more specifically?"),
      proposals,
      usage,
    };
  } catch (err) {
    console.error("Assistant failed", err instanceof Error ? err.message : err);
    return { error: "The assistant didn't answer just now. Please try again." };
  }
}

export type DecisionState = { error?: string; done?: "applied" | "dismissed" | "restored" };

export async function applyProposal(
  slug: string,
  proposalId: string,
  _prev: DecisionState,
  _formData: FormData,
): Promise<DecisionState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!canManage(ctx.role)) return { error: "Only owners and admins can apply changes." };
  const { error } = await ctx.supabase.rpc("apply_config_proposal", {
    p_proposal_id: proposalId,
  });
  if (error) {
    return {
      error: error.message.includes("already_decided")
        ? "This suggestion was already applied or dismissed."
        : "That didn't apply. Please try again.",
    };
  }
  revalidatePath(`/w/${slug}`, "layout");
  return { done: "applied" };
}

export async function dismissProposal(
  slug: string,
  proposalId: string,
  _prev: DecisionState,
  _formData: FormData,
): Promise<DecisionState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  await ctx.supabase.rpc("dismiss_config_proposal", { p_proposal_id: proposalId });
  revalidatePath(`/w/${slug}/assistant`);
  return { done: "dismissed" };
}

export async function restoreVersion(
  slug: string,
  versionId: string,
  _prev: DecisionState,
  _formData: FormData,
): Promise<DecisionState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!canManage(ctx.role)) return { error: "Only owners and admins can put a setting back." };
  const { error } = await ctx.supabase.rpc("restore_config_version", { p_version_id: versionId });
  if (error) return { error: "That couldn't be put back. Please try again." };
  revalidatePath(`/w/${slug}`, "layout");
  return { done: "restored" };
}

/**
 * Applies one of the assistant's Money proposals that isn't a setting: taken
 * once (`claim_action_proposal`), then done through the same checked
 * function the page uses, as this owner or admin. If that refuses, the
 * proposal is put back to wait.
 */
export async function applyActionProposal(
  slug: string,
  proposalId: string,
  _prev: DecisionState,
  _formData: FormData,
): Promise<DecisionState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!canManage(ctx.role)) return { error: "Only owners and admins can apply changes." };
  // The words of what changes, as the preview shows them now, for the history.
  const { data: pending } = await ctx.supabase
    .from("action_proposals")
    .select("id, kind, target, body, summary")
    .eq("id", proposalId)
    .eq("tenant_id", ctx.tenant.id)
    .maybeSingle();
  const preview = pending ? await previewAction(ctx.supabase, ctx.tenant, pending) : null;
  const { data, error } = await ctx.supabase.rpc("claim_action_proposal", { p_id: proposalId });
  const row = (
    (data ?? []) as { tenant_id: string; kind: string; target: string | null; body: unknown }[]
  )[0];
  if (error || !row || row.tenant_id !== ctx.tenant.id) {
    return {
      error: error?.message.includes("already_decided")
        ? "This suggestion was already applied or dismissed."
        : "That didn't apply. Please try again.",
    };
  }
  const done = await applyAction(ctx.supabase, ctx.tenant.id, row);
  if (done.error) {
    await ctx.supabase.rpc("reopen_action_proposal", { p_id: proposalId });
    return { error: done.error };
  }
  if (preview) {
    // Allowed to fail: the change is made; only its line in the history would be missing.
    const { error: noted } = await ctx.supabase.rpc("note_action_applied", {
      p_id: proposalId,
      p_before: preview.before,
      p_after: preview.after,
    });
    if (noted) console.warn(`Applied suggestion not noted: ${noted.message}`);
  }
  revalidatePath(`/w/${slug}`, "layout");
  return { done: "applied" };
}

export async function dismissActionProposal(
  slug: string,
  proposalId: string,
  _prev: DecisionState,
  _formData: FormData,
): Promise<DecisionState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  await ctx.supabase.rpc("dismiss_action_proposal", { p_id: proposalId });
  revalidatePath(`/w/${slug}/assistant`);
  return { done: "dismissed" };
}
