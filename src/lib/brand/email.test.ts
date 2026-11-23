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
    // Banners are back, designed with the workspace's own kit: its colours and nothing else,
    // no picture yet (it is drawn when the email is opened), in the banner shape.
    const banners = templates.flatMap((template) =>
      template.sections.flatMap((section) =>
        section.rows.flatMap((row) =>
          row.columns.flatMap((column) =>
            column.blocks.flatMap((block) => (block.type === "banner" ? [block] : [])),
          ),
        ),
      ),
    );
    expect(banners).toHaveLength(2);
    const own = new Set([...kit.colors.map((c) => c.hex), "#ffffff"]);
    for (const banner of banners) {
      expect(banner.image).toBe("");
      expect(banner.design.format).toBe("3:2");
      expect(banner.design.slides).toHaveLength(1);
      const slide = banner.design.slides[0];
      expect(slide.brand).toBeUndefined();
      const used = [
        slide.bg,
        slide.grid,
        slide.wave,
        ...slide.layers.flatMap((l) => [l.color, l.plateColor, l.scribble]),
      ].filter((hex): hex is string => Boolean(hex));
      for (const hex of used) expect(own.has(hex), hex).toBe(true);
      expect(slide.layers.some((l) => l.role === "headline" && l.text.trim())).toBe(true);
    }
    // The announcement opens on the main colour; the sale's banner stands out in the accent.
    expect(banners[0].design.slides[0].bg).toBe("#9cc4d9");
    expect(banners[1].design.slides[0].bg).toBe("#b5532c");
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
