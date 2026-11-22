import { describe, expect, it } from "vitest";
import {
  MAX_TEMPLATES,
  allBlocks,
  builtInTemplates,
  defaultDoc,
  docFromTemplate,
  docLinks,
  findBlock,
  newBlock,
  newRow,
  newSection,
  normalizeDoc,
  normalizeTemplates,
  optimize,
  reduceDoc,
  renderBlockHtml,
  renderDocHtml,
  sanitizeInline,
  templateFrom,
  videoThumbnail,
  type Block,
  type EmailDoc,
} from "./index";
import { BRAND_IDS } from "./brands";

const block = (
  type: Parameters<typeof newBlock>[0],
  id: string,
  more: Record<string, unknown> = {},
) => ({ ...newBlock(type), id, ...more }) as Block;
const doc = (blocks: Block[], platform: "shopify" | "other" = "shopify"): EmailDoc => ({
  ...defaultDoc("ttw", platform),
  sections: [
    {
      ...newSection(
        "Body",
        blocks.map((b) => newRow("1", [b])),
      ),
      id: "body",
    },
  ],
});
const part = (d: EmailDoc, id: string) => renderBlockHtml(d, id);
const SOCIALS = [
  { network: "instagram", url: "https://www.instagram.com/tufttheworld" },
  { network: "tiktok", url: "" },
  { network: "youtube", url: "https://www.youtube.com/@tufttheworld" },
];

describe("the Social block", () => {
  it("starts with accounts to fill in, and is left out until one has an address", () => {
    const d = doc([block("social", "s")]);
    expect(findBlock(d, "s")?.block).toMatchObject({
      look: "links",
      links: [
        { network: "instagram", url: "" },
        { network: "tiktok", url: "" },
        { network: "facebook", url: "" },
      ],
    });
    expect(part(d, "s").html).toBe("");
  });
  it("shows the accounts with addresses as words, linked, with no pictures", () => {
    const html = part(doc([block("social", "s", { links: SOCIALS })]), "s").html;
    expect(html).toContain(
      '<a href="https://www.instagram.com/tufttheworld" style="color:#0051ff;text-decoration:underline;">Instagram</a> &nbsp;&middot;&nbsp; <a href="https://www.youtube.com/@tufttheworld" style="color:#0051ff;text-decoration:underline;">YouTube</a></p>',
    );
    expect(html).not.toMatch(/<img|TikTok/);
    expect(html).toContain("font-size:14px;line-height:1.6;color:#0051ff;text-align:center;");
  });
  it("can show each in an outlined cell, four to a row, which Outlook draws too", () => {
    const all = (["instagram", "tiktok", "facebook", "youtube", "pinterest", "x"] as const).map(
      (network) => ({ network, url: `https://example.org/${network}` }),
    );
    const d = reduceDoc(doc([block("social", "s", { links: all, look: "pills" })]), {
      type: "updateBlockStyles",
      id: "s",
      patch: { color: "#213838", size: 16, align: "left" },
    });
    const html = part(d, "s").html;
    expect(
      html.match(/border:1px solid #213838;border-radius:999px;padding:5px 14px;/g),
    ).toHaveLength(6);
    expect(
      html.match(
        /<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="left" style="margin:0;"><tr>/g,
      ),
    ).toHaveLength(2);
    expect(html).toContain(
      'font-size:16px;line-height:1.6;color:#213838;text-decoration:none;white-space:nowrap;">Pinterest</a>',
    );
    expect(html.match(/<table/g)!.length).toBe(html.match(/role="presentation"/g)!.length);
  });
  it("only keeps known accounts with secure addresses when it is read", () => {
    const read = allBlocks(
      normalizeDoc(
        JSON.parse(
          JSON.stringify(
            doc([
              block("social", "s", {
                look: "odd",
                links: [
                  ...SOCIALS,
                  { network: "myspace", url: "https://x.example.org" },
                  { network: "x", url: "javascript:alert(1)" },
                  { network: "facebook", url: "http://facebook.com/x" },
                ],
              }),
            ]),
          ),
        ),
      ),
    )[0];
    expect(read).toMatchObject({
      look: "links",
      links: [
        { network: "instagram", url: "https://www.instagram.com/tufttheworld" },
        { network: "tiktok", url: "" },
        { network: "youtube" },
        { network: "x", url: "" },
        { network: "facebook", url: "" },
      ],
    });
  });
  it("has its links listed for checking", () => {
    expect(
      docLinks(doc([block("social", "s", { links: SOCIALS })])).map((l) => [l.label, l.url]),
    ).toEqual([
      ["Social: Instagram", "https://www.instagram.com/tufttheworld"],
      ["Social: TikTok", ""],
      ["Social: YouTube", "https://www.youtube.com/@tufttheworld"],
    ]);
  });
});

describe("the Video block", () => {
  it("works out a YouTube still from the address alone, and nothing for anywhere else", () => {
    const still = "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg";
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ&t=10s",
      "https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?si=abc",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      " https://youtu.be/dQw4w9WgXcQ ",
    ])
      expect(videoThumbnail(url), url).toBe(still);
    for (const url of [
      "",
      "https://vimeo.com/123456789",
      "https://www.youtube.com/",
      "https://www.youtube.com/watch?v=short",
      "http://youtu.be/dQw4w9WgXcQ",
      "https://evil.example.org/?u=https://youtu.be/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQextra",
      "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be.evil.example.org/dQw4w9WgXcQ",
    ]) {
      expect(videoThumbnail(url), url).toBe("");
    }
  });
  it("is a still picture behind a play mark made of text, both linked to the video, with the same picture given to Outlook", () => {
    const d = doc([
      block("video", "v", {
        url: "https://youtu.be/dQw4w9WgXcQ",
        thumbnail: "https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        alt: 'How to "tuft"',
      }),
    ]);
    const { html, phoneCss } = part(d, "v");
    expect(html).toContain(
      'background="https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg" bgcolor="#000000" height="302"',
    );
    expect(html).toContain(
      "background-image:url('https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg');background-size:cover;",
    );
    expect(html).toContain(
      '<!--[if gte mso 9]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:536px;height:302px;"><v:fill type="frame" src="https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg" color="#000000" /><v:textbox inset="0,0,0,0"><![endif]-->',
    );
    expect(html).toContain("<!--[if gte mso 9]></v:textbox></v:rect><![endif]-->");
    expect(html.match(/href="https:\/\/youtu\.be\/dQw4w9WgXcQ"/g)).toHaveLength(2);
    expect(html).toContain("&#9654;</a>");
    expect(html).toContain('title="How to &quot;tuft&quot;"');
    expect(html).toContain(">How to &quot;tuft&quot;</a></td></tr></table>");
    expect(html).not.toMatch(/<img|<video|<iframe|<script/);
    expect(phoneCss).toContain("height:190px!important;");
    expect(
      part(reduceDoc(d, { type: "updateBlock", id: "v", patch: { alt: "" } }), "v").html,
    ).toContain(">Watch the video</a>");
  });
  it("is left out without both an address and a picture, and only takes secure addresses", () => {
    expect(
      part(doc([block("video", "v", { url: "https://youtu.be/dQw4w9WgXcQ" })]), "v").html,
    ).toBe("");
    expect(
      part(doc([block("video", "v", { thumbnail: "https://cdn.example.com/still.jpg" })]), "v")
        .html,
    ).toBe("");
    const read = allBlocks(
      normalizeDoc(
        JSON.parse(
          JSON.stringify(
            doc([
              block("video", "v", {
                url: "javascript:alert(1)",
                thumbnail: "http://insecure.example/x.jpg",
                alt: "x",
              }),
            ]),
          ),
        ),
      ),
    )[0];
    expect(read).toMatchObject({ type: "video", url: "", thumbnail: "", alt: "x" });
    expect(
      docLinks(doc([block("video", "v", { url: "https://vimeo.com/1", alt: "A film" })])),
    ).toMatchObject([{ label: "Video: A film", url: "https://vimeo.com/1" }]);
  });
});

describe("the Logo block", () => {
  const withLogo = (blocks: Block[]) =>
    reduceDoc(doc(blocks), {
      type: "setGlobalStyles",
      patch: {
        logo: {
          src: "https://cdn.example.com/logo.png",
          width: 96,
          align: "center",
          link: "https://tufttheworld.com",
        },
      },
    });
  it("shows the email's logo, at its own width, linked to the email's logo link", () => {
    const html = part(withLogo([block("logo", "l")]), "l").html;
    expect(html).toContain(
      'align="center" style="padding:22px 32px 18px 32px;"><a href="https://tufttheworld.com"><img src="https://cdn.example.com/logo.png" alt="Tuft the World" width="96" style="display:block;width:100%;max-width:96px;height:auto;border:0;margin:0 auto;"></a>',
    );
  });
  it("can have its own picture, link, width and place, and a narrower width on a phone", () => {
    const d = [
      {
        type: "updateBlock",
        id: "l",
        patch: {
          src: "https://cdn.example.com/light.png",
          link: "https://tufttheworld.com/home",
          width: 200,
          mobileWidth: 120,
        },
      } as const,
      {
        type: "updateBlockStyles",
        id: "l",
        patch: { align: "left", sameForMobile: false },
      } as const,
    ].reduce(reduceDoc, withLogo([block("logo", "l")]));
    const { html, phoneCss } = part(d, "l");
    expect(html).toMatch(
      /<a href="https:\/\/tufttheworld\.com\/home"><img class="(eb-m\d+)" src="https:\/\/cdn\.example\.com\/light\.png" alt="Tuft the World" width="200" style="display:block;width:100%;max-width:200px;height:auto;border:0;margin:0;">/,
    );
    expect(phoneCss).toContain("max-width:120px!important;");
    // With "same on a phone" on, the phone width is not used.
    expect(
      part(
        reduceDoc(d, { type: "updateBlockStyles", id: "l", patch: { sameForMobile: true } }),
        "l",
      ).phoneCss,
    ).not.toContain("max-width");
    expect(normalizeDoc(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });
  it("is left out when there is no logo anywhere, and defaults to the brand's usual size", () => {
    expect(part(doc([block("logo", "l")]), "l").html).toBe("");
    expect(newBlock("logo", "pyc")).toMatchObject({ width: 260, alt: "Price Your Craft" });
    expect(newBlock("logo", "ttw")).toMatchObject({ width: 96, mobileWidth: 80 });
    expect(docLinks(withLogo([block("logo", "l")]))).toMatchObject([
      { label: "Logo", url: "https://tufttheworld.com" },
    ]);
  });
});

describe("an unsubscribe link in text", () => {
  it("is kept by the text cleaner, exactly as the exporter knows it, and nothing like it is", () => {
    expect(sanitizeInline('<a href="{{ unsubscribe_link }}">Unsubscribe</a>')).toBe(
      '<a href="{{ unsubscribe_link }}">Unsubscribe</a>',
    );
    expect(sanitizeInline('<a href="PASTE-YOUR-UNSUBSCRIBE-LINK-HERE">Unsubscribe</a>')).toBe(
      '<a href="PASTE-YOUR-UNSUBSCRIBE-LINK-HERE">Unsubscribe</a>',
    );
    for (const href of [
      "{{ evil }}",
      "{{unsubscribe_link}}",
      "{{ unsubscribe_link }}x",
      "{{ open_tracking }}",
      "*|UNSUB|*",
      "{{ unsubscribe_link }} javascript:alert(1)",
    ])
      expect(sanitizeInline(`<a href="${href}">x</a>`), href).toBe("x");
  });
  it("is written for whichever platform the email is for when it is exported", () => {
    const d = (platform: "shopify" | "other", href: string) =>
      renderDocHtml(
        doc(
          [block("paragraph", "p", { html: `No more? <a href="${href}">Unsubscribe</a>` })],
          platform,
        ),
      );
    for (const href of ["{{ unsubscribe_link }}", "PASTE-YOUR-UNSUBSCRIBE-LINK-HERE"]) {
      expect(d("shopify", href)).toContain(
        '<a href="{{ unsubscribe_link }}" style="color:#0051ff;text-decoration:underline;">Unsubscribe</a>',
      );
      expect(d("other", href)).toContain(
        '<a href="PASTE-YOUR-UNSUBSCRIBE-LINK-HERE" style="color:#0051ff;text-decoration:underline;">Unsubscribe</a>',
      );
      expect(d("other", href)).not.toContain("{{");
    }
  });
});

describe("templates", () => {
  it("each brand has four starters, in its own colours, that need no pictures from anywhere", () => {
    for (const brand of BRAND_IDS) {
      const starters = builtInTemplates(brand);
      expect(starters.map((t) => t.name)).toEqual([
        "Announcement",
        "Product feature",
        "Newsletter",
        "Sale",
      ]);
      expect(starters.map((t) => t.id)).toEqual(
        ["announcement", "product", "newsletter", "sale"].map((k) => `starter-${brand}-${k}`),
      );
      for (const t of starters) {
        expect(t.brand).toBe(brand);
        const made = docFromTemplate(t, "shopify", { logo: "https://cdn.example.com/logo.png" });
        // A valid email as it stands, that saves and reopens exactly.
        expect(normalizeDoc(JSON.parse(JSON.stringify(made))), `${brand} ${t.name}`).toEqual(made);
        const html = renderDocHtml(made);
        expect(html).toContain("{{ unsubscribe_link }}");
        expect(
          [...html.matchAll(/(?:src|background)="([^"]*)"/g)]
            .map((m) => m[1])
            .filter((u) => u !== "https://cdn.example.com/logo.png"),
          `${brand} ${t.name}`,
        ).toEqual([]);
        expect(allBlocks(made).some((b) => b.type === "footer")).toBe(true);
        expect(
          allBlocks(made)
            .filter((b) => b.type === "button")
            .every((b) => b.type === "button" && !!b.label && !!b.url),
        ).toBe(true);
        // Nothing in a starter is wrong, only unfinished: no contrast, size or link problems.
        const found = optimize({
          ...made,
          meta: { subject: "A subject", previewText: "Preview" },
        }).map((s) => s.rule);
        expect(
          found.filter((r) => !["banner-unmade", "image-empty", "social-empty"].includes(r)),
          `${brand} ${t.name}`,
        ).toEqual([]);
      }
    }
    expect(builtInTemplates("pyc")[3].sections[1].rows[0].columns[0].blocks[0]).toMatchObject({
      type: "banner",
    });
    expect(builtInTemplates("nope")[0].brand).toBe("ttw");
  });
  it("give a new email with new ids each time, and use the brand's logo where the template has none", () => {
    const [t] = builtInTemplates("ttw");
    const a = docFromTemplate(t, "other", { logo: "https://cdn.example.com/logo.png" });
    const b = docFromTemplate(t);
    expect(a).toMatchObject({
      v: 2,
      brand: "ttw",
      platform: "other",
      title: "Untitled email",
      meta: { subject: "", previewText: "" },
      globalStyles: { logo: { src: "https://cdn.example.com/logo.png" } },
    });
    expect(b.globalStyles.logo.src).toBe("");
    const ids = [...allBlocks(a), ...allBlocks(b)].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      docFromTemplate(t, "shopify", { logo: "http://insecure.example/l.png" }).globalStyles.logo
        .src,
    ).toBe("");
  });
  it("are made from an email: its sections and styles, not its subject", () => {
    const email = reduceDoc(
      {
        ...doc([block("heading", "h", { html: "Hello" })]),
        title: "March news",
        meta: { subject: "Secret subject", previewText: "Secret preview" },
      },
      { type: "setGlobalStyles", patch: { pageBg: "#101010" } },
    );
    const t = templateFrom(email, "  My layout  ");
    expect(t).toMatchObject({
      name: "My layout",
      brand: "ttw",
      globalStyles: { pageBg: "#101010" },
    });
    expect(JSON.stringify(t)).not.toMatch(/Secret|March news/);
    expect(t.sections[0].rows[0].columns[0].blocks[0]).toMatchObject({
      type: "heading",
      html: "Hello",
    });
    expect(t.sections[0].rows[0].columns[0].blocks[0].id).not.toBe("h");
    expect(templateFrom(email, "").name).toBe("March news");
  });
  it("are checked like emails when read from settings, and anything else is dropped", () => {
    const t = templateFrom(doc([block("code", "c", { html: "<p>ok</p>" })]), "Mine");
    const stored = JSON.parse(
      JSON.stringify([
        t,
        null,
        5,
        { name: "No sections" },
        { name: "Empty", sections: [] },
        {
          name: "  ",
          brand: "nope",
          sections: [
            {
              name: "Body",
              rows: [
                {
                  columns: [
                    {
                      blocks: [
                        { type: "paragraph", html: "<script>x</script>hi" },
                        { type: "code", html: '<p onclick="x()">p</p>' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    );
    const read = normalizeTemplates(JSON.stringify(stored));
    expect(read.map((x) => [x.name, x.brand])).toEqual([
      ["Mine", "ttw"],
      ["Untitled template", "ttw"],
    ]);
    expect(read[0]).toEqual(t);
    expect(read[1].sections[0].rows[0].columns[0].blocks).toMatchObject([
      { type: "paragraph", html: "hi" },
      { type: "code", html: "<p>p</p>" },
    ]);
    expect(normalizeTemplates(JSON.stringify(read))).toEqual(read);
    for (const junk of ["", "not json", "{}", null, undefined, 7])
      expect(normalizeTemplates(junk)).toEqual([]);
    expect(normalizeTemplates(Array.from({ length: 40 }, () => t))).toHaveLength(MAX_TEMPLATES);
  });
  it("replace an email's structure and styles when applied, keeping its subject, name, platform and logo", () => {
    const email: EmailDoc = {
      ...doc([block("heading", "h", { html: "Old content" })], "other"),
      title: "March news",
      meta: { subject: "Kept subject", previewText: "Kept preview" },
    };
    const mine = reduceDoc(email, {
      type: "setGlobalStyles",
      patch: { logo: { ...email.globalStyles.logo, src: "https://cdn.example.com/mine.png" } },
    });
    const [, , newsletter] = builtInTemplates("ttw");
    const changed = reduceDoc(mine, {
      type: "applyTemplate",
      globalStyles: newsletter.globalStyles,
      sections: newsletter.sections,
    });
    expect(changed).toMatchObject({
      title: "March news",
      platform: "other",
      brand: "ttw",
      meta: { subject: "Kept subject", previewText: "Kept preview" },
      globalStyles: { logo: { src: "https://cdn.example.com/mine.png" } },
    });
    expect(changed.sections.map((s) => s.name)).toEqual(["Header", "Body", "Footer"]);
    expect(JSON.stringify(changed)).not.toContain("Old content");
    // The email is untouched, so undo has it to go back to; and applying twice gives separate copies.
    expect(findBlock(mine, "h")?.block).toMatchObject({ html: "Old content" });
    const again = reduceDoc(changed, {
      type: "applyTemplate",
      globalStyles: newsletter.globalStyles,
      sections: newsletter.sections,
    });
    expect(allBlocks(again).map((b) => b.id)).not.toEqual(allBlocks(changed).map((b) => b.id));
    expect(newsletter.sections[0].id).not.toBe(changed.sections[0].id);
    expect(
      reduceDoc(mine, {
        type: "applyTemplate",
        globalStyles: newsletter.globalStyles,
        sections: [],
      }),
    ).toBe(mine);
    // A template with its own logo brings it.
    const branded = {
      ...newsletter.globalStyles,
      logo: { ...newsletter.globalStyles.logo, src: "https://cdn.example.com/template.png" },
    };
    expect(
      reduceDoc(mine, {
        type: "applyTemplate",
        globalStyles: branded,
        sections: newsletter.sections,
      }).globalStyles.logo.src,
    ).toBe("https://cdn.example.com/template.png");
  });
});
