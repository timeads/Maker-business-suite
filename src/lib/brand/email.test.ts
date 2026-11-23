import { describe, expect, it } from "vitest";
import { normalizeDoc, renderDocHtml } from "../design";
import { emailRoles, newWorkspaceEmail, workspaceTemplates } from "./email";
import { brandKitSchema, contrast } from "./kit";

const kit = brandKitSchema.parse({
  version: 1,
  name: 'Wild "Thread" Studio',
  site: "wildthread.example",
  colors: [
    { name: "sky", hex: "#9cc4d9" },
    { name: "forest", hex: "#1f3d2b" },
    { name: "cream", hex: "#f6efe2" },
    { name: "rust", hex: "#b5532c" },
  ],
});

describe("emails in a workspace's own brand", () => {
  it("gives each colour a job", () => {
    expect(emailRoles(kit)).toEqual({
      primary: "#9cc4d9",
      dark: "#1f3d2b",
      light: "#f6efe2",
      accent: "#b5532c",
    });
  });

  it("recolours the starters and leaves nothing of the built-in brand behind", () => {
    const templates = workspaceTemplates(kit);
    expect(templates).toHaveLength(4);
    const text = JSON.stringify(templates);
    expect(text).not.toMatch(/tufttheworld|Tuft the World|#0051ff|#213838|#f5edeb|#ffe813/i);
    expect(text).toContain("https://wildthread.example");
    expect(text).toContain('Wild \\"Thread\\" Studio');
    expect(text).not.toContain('"type":"banner"');
    for (const template of templates) {
      // A pale main colour gets dark words on it, not the usual light ones.
      const button = template.globalStyles.button;
      expect(contrast(button.bg, button.color), template.name).toBeGreaterThan(4);
      for (const section of template.sections) {
        if (section.styles.contentBg && section.styles.textColor) {
          expect(
            contrast(section.styles.contentBg, section.styles.textColor),
            section.name,
          ).toBeGreaterThan(4);
        }
      }
    }
  });

  it("makes a new email that survives a save and renders", () => {
    const doc = newWorkspaceEmail(kit, null);
    const again = normalizeDoc(JSON.parse(JSON.stringify(doc)));
    expect(again.globalStyles.button.bg).toBe(doc.globalStyles.button.bg);
    expect(again.sections.length).toBe(doc.sections.length);
    const html = renderDocHtml(again);
    expect(html).toContain("#9cc4d9");
    expect(html).not.toMatch(/tufttheworld/i);
  });
});
