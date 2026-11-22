import { describe, expect, it } from "vitest";
import { MAX_CODE, sanitizeHtml } from "./html-sanitize";

const clean = (html: string) => sanitizeHtml(html).html;
const TAB = String.fromCharCode(9);
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);
const ZWSP = String.fromCharCode(0x200b);

/** Nothing in cleaned HTML may be able to run code or reach outside the email, however it got there. */
function expectInert(out: string, from: string) {
  const tags = out.match(/<[^>]*>/g) ?? [];
  for (const tag of tags) {
    expect(tag, from).toMatch(
      /^<\/?(table|tbody|thead|tr|td|th|div|span|p|h[1-4]|a|img|br|hr|ul|ol|li|strong|b|em|i|u|s|sup|sub|blockquote|center|font)(\s[^<>]*)?>$/,
    );
    // Every attribute is one of the allowed names, with a quoted value.
    const attrs = tag.replace(/^<\/?[a-z0-9]+/, "").replace(/>$/, "");
    expect(
      attrs.replace(
        /\s(href|src|alt|title|width|height|align|valign|style|class|colspan|rowspan|cellpadding|cellspacing|border|bgcolor|color|role|target|rel)="[^"<>]*"/g,
        "",
      ),
      `${from} => ${tag}`,
    ).toBe("");
    for (const m of tag.matchAll(/\s(href|src)="([^"]*)"/g))
      expect(m[2], `${from} => ${tag}`).toMatch(
        /^(https?:\/\/|mailto:|tel:|\{\{ unsubscribe_link \}\}$|PASTE-YOUR-UNSUBSCRIBE-LINK-HERE$)/,
      );
    for (const m of tag.matchAll(/\sstyle="([^"]*)"/g))
      expect(m[1].toLowerCase(), `${from} => ${tag}`).not.toMatch(
        /expression|javascript|behavio|binding|@import|\\|position\s*:\s*(fixed|absolute)|url\((?!\s*(&quot;|')?https:\/\/)/,
      );
  }
  // Outside tags there is no raw angle bracket or quote left to build one from.
  expect(out.replace(/<[^>]*>/g, ""), from).not.toMatch(/[<>"]/);
}

describe("sanitizeHtml: what is kept", () => {
  it("keeps email HTML as it is: tables, text, links, pictures and plain styles", () => {
    const html =
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" class="outer wide"><tbody><tr><td align="center" valign="top" colspan="2" style="padding:10px 20px;font-family:Arial, sans-serif;color:#213838">' +
      '<h2 style="margin:0">Hello</h2><p>Some <strong>bold</strong>, <em>soft</em>, <u>lined</u>, <s>struck</s>, x<sup>2</sup>, H<sub>2</sub>O.<br>Next line.</p>' +
      '<a href="https://tufttheworld.com/a?b=1&amp;c=2" title="Shop">Shop</a> <a href="mailto:hello@tufttheworld.com">Write</a> <a href="tel:+15551234567">Call</a> <a href="{{ unsubscribe_link }}">Unsubscribe</a>' +
      '<img src="https://cdn.example.com/a.png" alt="A rug" width="200" height="100" style="display:block;border:0"><hr><ul><li>One</li></ul><ol><li>Two</li></ol><blockquote>Quoted</blockquote><center><font color="red">Old style</font></center>' +
      "<div><span>In a span</span></div></td></tr></tbody></table>";
    const { html: out, removed } = sanitizeHtml(html);
    expect(out).toBe(html);
    expect(removed).toEqual([]);
  });
  it("reads a style written over several lines", () => {
    expect(
      clean(
        `<td style="${NL}  color: red;${NL}${TAB}font-family: Arial,${NL}    sans-serif;${NL}">x</td>`,
      ),
    ).toBe('<td style="color:red;font-family:Arial, sans-serif">x</td>');
  });
  it("keeps a background picture in a style only from a secure web address", () => {
    expect(
      clean('<td style="background-image:url(https://cdn.example.com/bg.png);color:red">x</td>'),
    ).toBe('<td style="background-image:url(https://cdn.example.com/bg.png);color:red">x</td>');
    expect(
      clean("<td style=\"background:url('https://cdn.example.com/bg.png') no-repeat\">x</td>"),
    ).toBe("<td style=\"background:url('https://cdn.example.com/bg.png') no-repeat\">x</td>");
    for (const bad of [
      "url(http://cdn.example.com/bg.png)",
      "url(data:image/png;base64,AAAA)",
      "url(javascript:alert(1))",
      "url(//cdn.example.com/x.png)",
      "url(/local.png)",
      "url (https://cdn.example.com/a.png)",
      "URL(https://a.example.com/a.png) url(data:x)",
    ]) {
      expect(clean(`<td style="color:red;background:${bad}">x</td>`), bad).toBe(
        '<td style="color:red">x</td>',
      );
    }
  });
  it("opens new-tab links safely, and writes every attribute in quotes", () => {
    expect(clean('<a href=https://tufttheworld.com target=_blank rel="opener">x</a>')).toBe(
      '<a href="https://tufttheworld.com" target="_blank" rel="noopener noreferrer">x</a>',
    );
    expect(clean("<a href='https://tufttheworld.com' target='_self'>x</a>")).toBe(
      '<a href="https://tufttheworld.com">x</a>',
    );
    expect(clean("<TD ALIGN=CENTER WIDTH=50%>x</TD>")).toBe(
      '<td align="center" width="50%">x</td>',
    );
    expect(
      clean('<img alt="5 &lt; 6 &quot;quoted&quot;" src="https://cdn.example.com/a.png">'),
    ).toBe('<img alt="5 &lt; 6 &quot;quoted&quot;" src="https://cdn.example.com/a.png">');
  });
  it("closes what is left open, ignores stray closings, and does not nest a link in a link", () => {
    expect(clean("<table><tr><td><b>bold")).toBe("<table><tr><td><b>bold</b></td></tr></table>");
    expect(clean("text</td></table></b>")).toBe("text");
    expect(clean("<b><i>x</b>y</i>")).toBe("<b><i>x</i></b>y");
    expect(
      clean('<a href="https://a.example.org">one<a href="https://b.example.org">two</a></a>'),
    ).toBe('<a href="https://a.example.org">one</a><a href="https://b.example.org">two</a>');
    expect(clean("<br></br><hr/><img src='https://cdn.example.com/a.png'/>")).toBe(
      '<br><hr><img src="https://cdn.example.com/a.png">',
    );
  });
  it("is steady: cleaning what is already clean changes nothing and reports nothing", () => {
    const samples = [
      '<p style="color:red">a &amp; b &lt; c</p>',
      '<a href="https://e.example.org/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">x</a>',
      "1 &lt; 2 &gt; 0",
      '<td style="font-family:&quot;Times New Roman&quot;, serif">x</td>',
      "",
    ];
    for (const s of samples) {
      const once = sanitizeHtml(s);
      expect(sanitizeHtml(once.html)).toEqual({ html: once.html, removed: [] });
    }
    expect(sanitizeHtml(null)).toEqual({ html: "", removed: [] });
    expect(sanitizeHtml(undefined).html).toBe("");
  });
});

describe("sanitizeHtml: what is taken out", () => {
  it("removes scripts, style sheets, frames, forms' workings and other active things, contents and all", () => {
    expect(sanitizeHtml("a<script>alert(1)</script>b")).toEqual({
      html: "ab",
      removed: ["a script"],
    });
    expect(clean("a<SCRIPT SRC=https://evil.example.org/x.js></SCRIPT>b")).toBe("ab");
    expect(clean("a<script>never closed <b>bold</b>")).toBe("a");
    expect(sanitizeHtml("a<style>td{color:red}</style>b")).toEqual({
      html: "ab",
      removed: ["a style sheet"],
    });
    for (const tag of [
      "iframe",
      "object",
      "embed",
      "svg",
      "math",
      "noscript",
      "template",
      "textarea",
      "select",
      "button",
      "title",
      "xmp",
      "noembed",
      "audio",
      "video",
      "canvas",
    ]) {
      expect(clean(`a<${tag} onload=alert(1)><b>inside</b></${tag}>b`), tag).toBe("ab");
    }
    expect(
      clean(
        'a<form action="https://evil.example.org"><input name="q" value="v"><b>kept words</b></form>b',
      ),
    ).toBe("a<b>kept words</b>b");
    expect(
      clean(
        '<link rel="stylesheet" href="https://evil.example.org/x.css"><meta http-equiv="refresh" content="0;url=https://evil.example.org"><base href="https://evil.example.org/">ok',
      ),
    ).toBe("ok");
    expect(clean("<html><head><title>T</title></head><body><p>ok</p></body></html>")).toBe(
      "<p>ok</p>",
    );
  });
  it("removes every event handler and every attribute not on the list", () => {
    expect(
      sanitizeHtml(
        '<td onclick="alert(1)" ONMOUSEOVER=alert(2) onError=\'x\' id="a" data-x="1" contenteditable tabindex=0 style="color:red">x</td>',
      ).html,
    ).toBe('<td style="color:red">x</td>');
    expect(sanitizeHtml('<p onclick="x">a</p>').removed).toContain(
      "code that runs on a click or other event",
    );
    expect(
      clean(
        '<img src="https://cdn.example.com/a.png" onerror="alert(1)" srcset="x 2x" loading="lazy">',
      ),
    ).toBe('<img src="https://cdn.example.com/a.png">');
    expect(
      clean(
        '<a href="https://tufttheworld.com" download ping="https://evil.example.org" formaction="javascript:x">x</a>',
      ),
    ).toBe('<a href="https://tufttheworld.com">x</a>');
    expect(clean('<div style="color:red" style="position:fixed" class="a" class="b">x</div>')).toBe(
      '<div style="color:red" class="a">x</div>',
    );
    expect(
      clean('<td href="https://tufttheworld.com" src="https://cdn.example.com/a.png">x</td>'),
    ).toBe("<td>x</td>");
    expect(
      clean(
        '<td width="100px" height="expression(1)" colspan="-1" align="evil" valign="x" bgcolor="url(x)" role="a b" class="a<b">x</td>',
      ),
    ).toBe("<td>x</td>");
  });
  it("keeps only web, email and phone addresses, however a bad one is disguised", () => {
    const bad = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      `java${TAB}script:alert(1)`,
      `java${NL}script:alert(1)`,
      `java${CR}script:alert(1)`,
      `${NUL}javascript:alert(1)`,
      `java${NUL}script:alert(1)`,
      `${ZWSP}javascript:alert(1)`,
      "jav&#x09;ascript:alert(1)",
      "jav&#9;ascript:alert(1)",
      "jav&#x0A;ascript:alert(1)",
      "jav&Tab;ascript:alert(1)",
      "jav&NewLine;ascript:alert(1)",
      "&#106;avascript:alert(1)",
      "&#x6A;avascript:alert(1)",
      "&#0000106avascript:alert(1)",
      "&#106&#97&#118&#97&#115&#99&#114&#105&#112&#116&#58alert(1)",
      "javascript&colon;alert(1)",
      "javascript&#58;alert(1)",
      "java&#0;script:alert(1)",
      "&#1;javascript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///etc/passwd",
      "blob:https://x.example.org/1",
      "about:blank",
      "ftp://x.example.org/",
      "//evil.example.org/x",
      "/relative",
      "relative.html",
      "#anchor",
      "?q=1",
      "https:",
      "https:/",
      "https://",
      "https:///x",
      "http://exa mple.com/",
      `https://example.com/${TAB}x`,
      "https://example.com/'onclick='x",
      'https://example.com/"onclick="x',
      "https://example.com/<script>",
      "https://example.com/\\..\\x",
      "mailto:",
      "tel:javascript:alert(1)",
      "{{ evil }}",
      "{{unsubscribe_link}}x",
    ];
    for (const href of bad) {
      const out = clean(`<a href="${href.replace(/"/g, "&quot;")}">click</a>`);
      expect(out, JSON.stringify(href)).toBe("<a>click</a>");
      const single = clean(`<a href='${href.replace(/'/g, "&#39;")}'>click</a>`);
      expect(single, JSON.stringify(href)).toBe("<a>click</a>");
    }
    for (const src of [...bad, "mailto:a@b.co", "tel:+15551234", "{{ unsubscribe_link }}"])
      expect(clean(`<img src="${src.replace(/"/g, "&quot;")}" alt="x">`), JSON.stringify(src)).toBe(
        '<img alt="x">',
      );
    expect(clean("<a href=javascript:alert(1)>x</a>")).toBe("<a>x</a>");
    expect(clean("<a href=`javascript:alert(1)`>x</a>")).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>').removed).toEqual([
      "a link that is not a web, email or phone address",
    ]);
    expect(clean('<a href="HTTPS://TuftTheWorld.com/A">x</a>')).toBe(
      '<a href="HTTPS://TuftTheWorld.com/A">x</a>',
    );
    expect(clean('<a href="PASTE-YOUR-UNSUBSCRIBE-LINK-HERE">x</a>')).toBe(
      '<a href="PASTE-YOUR-UNSUBSCRIBE-LINK-HERE">x</a>',
    );
  });
  it("filters styles: no scripts, no reaching outside the block, no breaking out of the attribute", () => {
    const gone = [
      "width:expression(alert(1))",
      "width:EXPRESSION(alert(1))",
      "width:expr/**/ession(alert(1))",
      "width:\\65xpression(alert(1))",
      "background:url(javascript:alert(1))",
      "background-image:url('javascript:alert(1)')",
      "behavior:url(https://evil.example.org/x.htc)",
      "-moz-binding:url(https://evil.example.org/x.xml#x)",
      "@import url(https://evil.example.org/x.css)",
      "@import 'https://evil.example.org/x.css'",
      "position:fixed",
      "position:absolute",
      "POSITION : FIXED",
      "position:sticky",
      "position:fixed !important",
      "-ms-filter:x",
      "-o-link:x",
      "color:red</style><script>alert(1)</script>",
      "color:red>x",
      "font-family:x&#59;",
      "width:1px/*",
      "background:url(https://ok.example.org/a.png) url(data:x)",
      'list-style:url("javascript:alert(1)")',
      "color:&#x65;xpression(1)",
    ];
    for (const css of gone) {
      const out = clean(`<td style="color:blue;${css.replace(/"/g, "&quot;")};margin:0">x</td>`);
      expectInert(out, css);
      expect(out, css).toContain("color:blue");
      expect(out, css).toContain("margin:0");
    }
    expect(sanitizeHtml('<td style="position:fixed;top:0">x</td>')).toEqual({
      html: '<td style="top:0">x</td>',
      removed: ["part of a style"],
    });
    expect(clean('<td style="position:relative;z-index:2">x</td>')).toBe(
      '<td style="position:relative;z-index:2">x</td>',
    );
    // Trying to end the attribute or the tag from inside the style only produces text.
    expectInert(clean('<td style="color:red" onclick="alert(1)">x</td>'), "attr");
    expectInert(
      clean('<td style="color:red&quot; onclick=&quot;alert(1)">x</td>'),
      "encoded quote",
    );
    expectInert(clean("<td style='color:red\" onclick=\"alert(1)'>x</td>"), "mixed quotes");
    expectInert(clean('<td style="color:red"><<script>alert(1)</script>'), "double bracket");
  });
  it("removes comments, including the ones Outlook reads, doctypes and processing instructions", () => {
    expect(sanitizeHtml("a<!-- <script>alert(1)</script> -->b")).toEqual({
      html: "ab",
      removed: ["a comment"],
    });
    expect(clean('a<!--[if mso]><v:roundrect href="https://evil.example.org"><![endif]-->b')).toBe(
      "ab",
    );
    expect(clean("a<!--[if !mso]><!--><b>shown</b><!--<![endif]-->b")).toBe("a<b>shown</b>b");
    expect(clean("a<![if !mso]><b>shown</b><![endif]>b")).toBe("a<b>shown</b>b");
    expect(clean("<!DOCTYPE html><?xml version='1.0'?><![CDATA[x]]>ok")).toBe("ok");
    expect(clean("a<!-- never closed <b>x</b>")).toBe("a");
    expect(clean("a<!--><script>alert(1)</script>-->b")).toBe("ab");
    expect(clean("a<!---><img src=x onerror=alert(1)>-->b")).toBe("ab");
  });
  it("leaves anything that only looks like a tag as the characters typed", () => {
    expect(clean('1 < 2 > 0 & "q"')).toBe("1 &lt; 2 &gt; 0 &amp; &quot;q&quot;");
    expect(clean("<script src=x")).toBe("&lt;script src=x");
    expect(clean('<img src="x onerror=alert(1)>')).toBe("&lt;img src=&quot;x onerror=alert(1)&gt;");
    expect(clean("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(clean(`a${NUL}b${String.fromCharCode(7)}c`)).toBe("abc");
  });
  it("is cut off at a fixed length, and says so", () => {
    const long = sanitizeHtml(`<p>${"x".repeat(MAX_CODE * 2)}</p>`);
    expect(long.html.length).toBeLessThanOrEqual(MAX_CODE + 10);
    expect(long.html.endsWith("</p>")).toBe(true);
    expect(long.removed[0]).toMatch(/everything after the first 20000 characters/);
    expect(clean("<div>".repeat(500) + "deep").match(/<div>/g)).toHaveLength(60);
  });
});

describe("sanitizeHtml: tricks that rely on how browsers re-read HTML", () => {
  const attacks = [
    "<img src=x onerror=alert(1)>",
    '<img src="x" onerror="alert(1)">',
    "<IMG SRC=JaVaScRiPt:alert(1)>",
    "<img/src=x/onerror=alert(1)>",
    "<img src=x onerror=alert(1)//",
    "<img src=`x`onerror=alert(1)>",
    "<svg><script>alert(1)</script></svg>",
    "<svg onload=alert(1)>",
    '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
    '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    "<textarea><img src=x onerror=alert(1)></textarea>",
    "<title><img src=x onerror=alert(1)></title>",
    "<xmp><img src=x onerror=alert(1)></xmp>",
    '<style><img src="</style><img src=x onerror=alert(1)//">',
    '<p title="</p><script>alert(1)</script>">x</p>',
    '<a title="x" href="javascript:alert(1)" title="y">x</a>',
    '<a href="https://ok.example.org" href="javascript:alert(1)">x</a>',
    '<table><td><a href="javascript:alert(1)">x</a></table>',
    "<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>",
    "<scr<script>ipt>alert(1)</scr</script>ipt>",
    "<<script>alert(1)//<</script>",
    "<script<b>alert(1)</script>",
    "<b <script>alert(1)</script>0",
    '<img """><script>alert(1)</script>">',
    "<script/x>alert(1)</script>",
    '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;">',
    '<object data="javascript:alert(1)">',
    '<embed src="javascript:alert(1)">',
    '<base href="javascript:alert(1)//">',
    '<meta http-equiv="refresh" content="0;javascript:alert(1)">',
    '<div style="background:url(javascript:alert(1))">',
    '<div style="width:expression(alert(1))">',
    '<div style="x:\\65\\78pression(alert(1))">',
    '<p style="color:red;" onmouseover="alert(1)">',
    '<a href="jav&#x09;ascript:alert(1)">x</a>',
    '<a href="&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;alert(1)">x</a>',
    '<a href="javascript&colon;alert(1)">x</a>',
    '<a href="  javascript:alert(1)">x</a>',
    `<a href="java${TAB}script:alert(1)">x</a>`,
    "<a href='javascript:alert(1)'>x</a>",
    "<a href=javascript&#58;alert(1)>x</a>",
    '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
    "<input onfocus=alert(1) autofocus>",
    "<details open ontoggle=alert(1)>",
    "<body onload=alert(1)>",
    "<marquee onstart=alert(1)>",
    "<video><source onerror=alert(1)>",
    "<audio src=x onerror=alert(1)>",
    '<link rel=import href="https://evil.example.org">',
    "<!--[if gte IE 4]><script>alert(1)</script><![endif]-->",
    "<![CDATA[<script>alert(1)</script>]]>",
    '<?xml-stylesheet href="javascript:alert(1)"?>',
    '<td background="javascript:alert(1)">x</td>',
    '<table background="https://evil.example.org/track.gif">',
    '<font face="x" style="behavior:url(x.htc)">',
    '<a href="https://ok.example.org" target="_blank" rel="opener">x</a>',
    '<a href="https://ok.example.org" target="_top">x</a>',
    '<img src="https://ok.example.org/a.png" style="position:fixed;top:0;left:0;width:100%;height:100%">',
    "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    "<p>&#60;script&#62;alert(1)&#60;/script&#62;</p>",
    '<p title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">x</p>',
    '<img alt="\'><script>alert(1)</script>" src="https://ok.example.org/a.png">',
  ];
  it.each(attacks)("%s", (attack) => {
    const out = clean(attack);
    expectInert(out, attack);
    // Whatever is left of an attack is plain words: none of these can be a tag any more, and no tag carries an event handler.
    expect(out).not.toMatch(
      /<script|<svg|<math|<iframe|<object|<embed|<style|<form|<input|<base|<meta|<link/i,
    );
    for (const tag of out.match(/<[^>]*>/g) ?? [])
      expect(tag).not.toMatch(/\son[a-z]+\s*=|javascript:/i);
    // Cleaning it a second time changes nothing: there is no second reading that differs from the first.
    expect(clean(out), attack).toBe(out);
  });
  it("holds for any jumble of tags, attributes, quotes and encodings", () => {
    const parts = [
      "<",
      ">",
      '"',
      "'",
      "=",
      "&",
      ";",
      "/",
      " ",
      "<a",
      "<img",
      "<td",
      "<div",
      "<p",
      "</a>",
      "</td>",
      "</div>",
      "<script>",
      "</script>",
      "<style>",
      "</style>",
      "<svg>",
      "<!--",
      "-->",
      "<![endif]>",
      " href=",
      " src=",
      " style=",
      " onclick=",
      " title=",
      " class=",
      " width=",
      "javascript:",
      "https://ok.example.org/x",
      "data:",
      "url(",
      ")",
      "expression(",
      "position:fixed",
      "color:red",
      "&#x09;",
      "&#58;",
      "&colon;",
      "&quot;",
      "&lt;",
      "&gt;",
      "&amp;",
      "&#",
      "x",
      "1",
      "`",
      "\\",
      TAB,
      NL,
      NUL,
      "{{ unsubscribe_link }}",
      "mailto:a@b.co",
      "@import",
    ];
    let seed = 20261122;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 3000; n++) {
      const input = Array.from(
        { length: 1 + Math.floor(next() * 18) },
        () => parts[Math.floor(next() * parts.length)],
      ).join("");
      const out = clean(input);
      expectInert(out, JSON.stringify(input));
      expect(clean(out), JSON.stringify(input)).toBe(out);
      const opens = (out.match(/<(?!\/|br|hr|img)[a-z0-9]+/g) ?? []).length;
      expect((out.match(/<\//g) ?? []).length, JSON.stringify(input)).toBe(opens);
    }
  });
});
