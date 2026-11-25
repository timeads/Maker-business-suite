import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CLAUDE.md rule 6: AI drafts never auto-send to end customers. The
 * automatic first reply is the one thing the help desk sends by itself, so
 * it may only ever carry words a person saved. This reads the source: no
 * file on the path from "a message was filed" to "the words were handed to
 * Meta or the mail service" may import the Anthropic SDK or any of the
 * suite's model helpers, directly or through something it imports.
 */

const HERE = __dirname;
const SRC = resolve(HERE, "../../..");
const rel = (file: string) => relative(SRC, file).replace(/\\/g, "/");

/** Every file in the suite that talks to a model. Found by reading, so a new one is caught too. */
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
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Everything a set of files reaches through its imports, and every package named on the way. */
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

const own = readdirSync(HERE)
  .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
  .map((name) => join(HERE, name));
/** The road the words travel after the claim: the outbox's shapes and the two deliverers. */
const ROAD = [
  "lib/helpdesk/outbox.ts",
  "lib/helpdesk/outbound.ts",
  "lib/helpdesk/social/deliver.ts",
  "lib/helpdesk/social/server.ts",
  "lib/helpdesk/social/graph.ts",
  "lib/helpdesk/inbound.ts",
  "lib/helpdesk/social/intake.ts",
].map((file) => join(SRC, file));

describe("the automatic reply never asks a model", () => {
  const callers = modelCallers();
  const reached = reach([...own, ...ROAD]);

  it("knows which files do (so this test would notice)", () => {
    const names = callers.map(rel);
    expect(names).toContain("lib/helpdesk/draft.ts");
    expect(names).toContain("lib/helpdesk/manual/reader.ts");
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(own.map(rel).sort()).toEqual([
      "lib/helpdesk/auto-reply/config.ts",
      "lib/helpdesk/auto-reply/rules.ts",
      "lib/helpdesk/auto-reply/worker.ts",
    ]);
  });

  it("imports no model helper, directly or through anything it imports", () => {
    // The walk really follows imports: these are two and three steps away.
    const seen = [...reached.files].map(rel);
    expect(seen).toContain("lib/helpdesk/rich.ts");
    expect(seen).toContain("lib/supabase/admin.ts");
    expect(seen).toContain("lib/connections/tokens.ts");
    expect(seen.length).toBeGreaterThan(20);
    const hit = callers.filter((file) => reached.files.has(file)).map(rel);
    expect(hit).toEqual([]);
    for (const name of reached.packages) {
      expect(name, name).not.toMatch(/anthropic|openai|claude|\bai\b|llm/i);
    }
    // Nor the help desk's drafting, summarising and reading helpers, by name.
    const names = [...reached.files].map(rel);
    for (const banned of [
      "lib/helpdesk/draft.ts",
      "lib/helpdesk/insights.ts",
      "lib/helpdesk/manual/reader.ts",
      "lib/helpdesk/help-centre/draft.ts",
      "lib/assistant/run.ts",
    ]) {
      expect(names, banned).not.toContain(banned);
    }
  });

  it("holds no way to reach one either: its own files make no request of their own", () => {
    for (const file of own) {
      const text = readFileSync(file, "utf8");
      expect(text, rel(file)).not.toMatch(
        /\bfetch\s*\(|api\.anthropic|ANTHROPIC_API_KEY|messages\.create/,
      );
    }
  });

  it("reads its words only from the saved setting", () => {
    const rules = readFileSync(join(HERE, "rules.ts"), "utf8");
    // The text that goes out is one of the two saved messages, filled in by `fillWords`.
    expect(rules).toMatch(
      /fillWords\(variant === "away" \? channel\.away_message : channel\.message/,
    );
    const worker = readFileSync(join(HERE, "worker.ts"), "utf8");
    expect(worker).toMatch(/textToRich\(decision\.text\)/);
    expect(worker.match(/textToRich\(/g)).toHaveLength(1);
  });
});
