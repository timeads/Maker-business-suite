import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CLAUDE.md rule 6: AI drafts never auto-send to end customers. Booking
 * texts go to customers by themselves, so they may only ever carry words a
 * person saved (or our standard ones), filled in by code. This reads the
 * source, as the help desk's automatic-reply guard does: no file in this
 * folder, nor the Twilio connection and webhook beside it, may import the
 * Anthropic SDK or any of the suite's model helpers, directly or through
 * something it imports.
 */

const HERE = __dirname;
const SRC = resolve(HERE, "../..");
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
const ROAD = [
  "lib/connections/providers/twilio.ts",
  "app/api/webhooks/twilio/route.ts",
  "lib/bookings/shop.ts",
].map((file) => join(SRC, file));

describe("booking texts never ask a model", () => {
  const callers = modelCallers();
  const reached = reach([...own, ...ROAD]);

  it("knows which files do (so this test would notice)", () => {
    const names = callers.map(rel);
    expect(names).toContain("lib/helpdesk/draft.ts");
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(own.map(rel).sort()).toEqual([
      "lib/texts/access.ts",
      "lib/texts/config.ts",
      "lib/texts/opt-out.ts",
      "lib/texts/phone.ts",
      "lib/texts/queue.ts",
      "lib/texts/read.ts",
      "lib/texts/segments.ts",
      "lib/texts/sends.ts",
      "lib/texts/signature.ts",
      "lib/texts/twilio-client.ts",
      "lib/texts/words.ts",
    ]);
  });

  it("imports no model helper, directly or through anything it imports", () => {
    const seen = [...reached.files].map(rel);
    // The walk really follows imports: these are a few steps away.
    expect(seen).toContain("lib/bookings/words.ts");
    expect(seen).toContain("lib/bookings/server.ts");
    expect(seen).toContain("lib/connections/tokens.ts");
    expect(seen.length).toBeGreaterThan(20);
    expect(callers.filter((file) => reached.files.has(file)).map(rel)).toEqual([]);
    for (const name of reached.packages) {
      expect(name, name).not.toMatch(/anthropic|openai|claude|\bai\b|llm/i);
    }
    for (const banned of [
      "lib/helpdesk/draft.ts",
      "lib/helpdesk/insights.ts",
      "lib/assistant/run.ts",
      "lib/brand/draft.ts",
    ]) {
      expect(seen, banned).not.toContain(banned);
    }
  });

  it("talks to nobody but Twilio: one client file makes the requests", () => {
    for (const file of own) {
      const text = readFileSync(file, "utf8");
      expect(text, rel(file)).not.toMatch(/api\.anthropic|ANTHROPIC_API_KEY|messages\.create/);
      if (!file.endsWith("twilio-client.ts")) expect(text, rel(file)).not.toMatch(/\bfetch\s*\(/);
    }
    const client = readFileSync(join(HERE, "twilio-client.ts"), "utf8");
    expect(client.match(/https:\/\/[a-z.]+/g)).toEqual(["https://api.twilio.com"]);
  });

  it("sends only the saved words, filled in by code", () => {
    const sends = readFileSync(join(HERE, "sends.ts"), "utf8");
    expect(sends).toMatch(/deps\.send\(access, to, textFor\(claim\.kind, about, settings\)\)/);
    expect(sends.match(/deps\.send\(/g)).toHaveLength(1);
  });
});
