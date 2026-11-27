import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The monthly summary is written by AI and only ever shown on Money to
 * owners and admins: never emailed, texted, posted or sent anywhere
 * (CLAUDE.md rule 6). This reads the source: only the summary's own page,
 * card, action and loader may import it, so nothing on a path that sends
 * (mail, texts, the worker, the outbox, the help desk, social) can reach it,
 * and the summary itself imports nothing that sends.
 */

const ROOT = resolve(__dirname, "../../..");
const rel = (file: string) => relative(ROOT, file).replace(/\\/g, "/");

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const ALLOWED = new Set([
  "src/lib/dashboard/summary-data.ts",
  "src/app/w/[slug]/(app)/dashboard/summary-actions.ts",
  "src/app/w/[slug]/(app)/dashboard/summary-button.tsx",
  "src/app/w/[slug]/(app)/dashboard/summary-card.tsx",
  "src/app/w/[slug]/(app)/dashboard/page.tsx",
]);
const SUMMARY_FILES = new Set([
  "src/lib/dashboard/summary.ts",
  "src/lib/dashboard/summary-data.ts",
  "src/app/w/[slug]/(app)/dashboard/summary-actions.ts",
  "src/app/w/[slug]/(app)/dashboard/summary-button.tsx",
  "src/app/w/[slug]/(app)/dashboard/summary-card.tsx",
]);
const IMPORT = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function target(from: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? join(ROOT, "src", spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(from), spec)
      : null;
  if (!base) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return rel(candidate);
  }
  return null;
}

describe("the monthly summary stays on Money's page", () => {
  it("is imported only by its own page, card, action and loader", () => {
    const importers = new Set<string>();
    for (const file of [...sources(join(ROOT, "src")), ...sources(join(ROOT, "worker"))]) {
      for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
        const to = target(file, match[1] ?? match[2]);
        if (to && SUMMARY_FILES.has(to)) importers.add(rel(file));
      }
    }
    expect(importers.size).toBeGreaterThan(0);
    for (const file of importers) expect(ALLOWED.has(file), file).toBe(true);
  });

  it("imports nothing that sends", () => {
    for (const file of [
      "src/lib/dashboard/summary.ts",
      "src/lib/dashboard/summary-data.ts",
      "src/app/w/[slug]/(app)/dashboard/summary-actions.ts",
    ]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, file).not.toMatch(
        /from\s+["'][^"']*(?:\/email|\/texts|outbox|deliver|twilio|helpdesk|social|resend|gmail)[^"']*["']/i,
      );
    }
  });
});
