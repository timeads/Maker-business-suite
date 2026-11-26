import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CLAUDE.md rule 6: AI drafts never schedule, post or send by themselves.
 * The monthly run and the style notes call Claude; posting must not. This
 * reads the source: nothing on the path from "a post is due" to "Meta,
 * TikTok or LinkedIn was asked" imports the Anthropic SDK or any of the
 * suite's model helpers, directly or through something it imports. And the
 * run itself has no way to schedule: it only ever calls the one filing
 * function, which writes drafts.
 */

const SRC = resolve(__dirname, "../..");
const rel = (file: string) => relative(SRC, file).replace(/\\/g, "/");

function modelCallers(dir = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) modelCallers(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      if (/from\s+["']@anthropic-ai\//.test(readFileSync(full, "utf8"))) out.push(full);
    }
  }
  return out;
}

const IMPORT = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? join(SRC, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(from), spec)
      : null;
  if (!base) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function reach(roots: string[]) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const spec = match[1] ?? match[2];
      const next = resolveImport(file, spec);
      if (next) queue.push(next);
      else if (!spec.startsWith(".") && !spec.startsWith("@/")) packages.add(spec);
    }
  }
  return { files, packages };
}

const SEND = [
  "lib/social/worker.ts",
  "lib/social/publish.ts",
  ...readdirSync(join(SRC, "lib/social/send"))
    .filter((name) => /\.ts$/.test(name) && !/\.test\.ts$/.test(name))
    .map((name) => `lib/social/send/${name}`),
].map((file) => join(SRC, file));

describe("posting never asks a model", () => {
  const callers = modelCallers();

  it("knows which files do (so this test would notice)", () => {
    const names = callers.map(rel);
    expect(names).toContain("lib/social/caption.ts");
    expect(names).toContain("lib/social/month-writer.ts");
    expect(names).toContain("lib/social/slide-writer.ts");
    expect(names).toContain("lib/social/style-notes.ts");
  });

  it("imports no model helper on the way to the networks", () => {
    const reached = reach(SEND);
    expect([...reached.files].map(rel)).toContain("lib/social/send/tiktok.ts");
    const hit = callers.filter((file) => reached.files.has(file)).map(rel);
    expect(hit).toEqual([]);
    for (const name of reached.packages) {
      expect(name, name).not.toMatch(/anthropic|openai|claude|\bai\b|llm/i);
    }
  });

  it("the monthly run's only write is the drafts' filing function", () => {
    const run = readFileSync(join(SRC, "lib/social/month-run.ts"), "utf8");
    const rpcs = [...run.matchAll(/rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect([...new Set(rpcs)]).toEqual([
      "file_social_month_draft",
      "finish_social_month_run",
      "record_usage",
    ]);
    expect(run).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(run).not.toMatch(/approve_social|save_social_post|claim_due_social/);
  });
});
