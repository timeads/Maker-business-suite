import { describe, expect, it } from "vitest";
import { emailSystemPrompt } from "./email-prompt";

const base = {
  fromPost: false,
  today: "Saturday, November 21, 2026",
  hasProducts: false,
  home: "https://tufttheworld.com",
  brandVoice: "",
  styleNotes: "",
};

describe("emailSystemPrompt", () => {
  it("builds for every brand, each introduced as itself with its own rule about facts", () => {
    const ttw = emailSystemPrompt({ ...base, brand: "ttw", hasProducts: true });
    expect(ttw).toMatch(/^You write marketing emails for Tuft the World/);
    expect(ttw).toContain("exactly as the catalogue lists them");
    expect(ttw).toContain("PRODUCTS: the shop's catalogue");
    const pyc = emailSystemPrompt({
      ...base,
      brand: "pyc",
      home: "https://www.priceyourcraft.com",
    });
    expect(pyc).toMatch(/^You write emails for Price Your Craft/);
    expect(pyc).toContain("must be called an example");
    expect(pyc).toContain("link the button to https://www.priceyourcraft.com");
    const history = emailSystemPrompt({
      ...base,
      brand: "history",
      home: "https://www.historyoftuftedrugs.com",
    });
    expect(history).toMatch(/^You write emails for A History of Tufted Rugs/);
    expect(history).toContain("THE HISTORY IN BRIEF");
    for (const text of [ttw, pyc, history]) {
      expect(text).toContain("Today is Saturday, November 21, 2026.");
      expect(text).not.toMatch(/undefined|\[object/);
    }
  });
  it("an unknown brand is written as Tuft the World", () => {
    expect(emailSystemPrompt({ ...base, brand: "nope" })).toMatch(
      /^You write marketing emails for Tuft the World/,
    );
  });
  it("changes its instructions when the email is made from a post", () => {
    expect(emailSystemPrompt({ ...base, brand: "ttw", fromPost: true })).toContain(
      "FROM THE POST:",
    );
    expect(emailSystemPrompt({ ...base, brand: "ttw" })).not.toContain("FROM THE POST:");
  });
  it("uses the owner's brand voice for Tuft the World only, and the style notes for all", () => {
    const opts = { ...base, brandVoice: "Warm and plain.", styleNotes: "No emoji." };
    expect(emailSystemPrompt({ ...opts, brand: "ttw" })).toContain("Warm and plain.");
    expect(emailSystemPrompt({ ...opts, brand: "pyc" })).not.toContain("Warm and plain.");
    expect(emailSystemPrompt({ ...opts, brand: "pyc" })).toContain("No emoji.");
  });
});
