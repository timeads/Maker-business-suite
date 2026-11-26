/*
 * "Upcoming classes" for a shop's own workshops page: the open dates of every
 * workshop the business sells through its shop, each with a link to that
 * workshop's product page, where the date picker is.
 *
 * Plain JavaScript on purpose: no build step, no libraries, drawn inside a
 * shadow root so the shop's styles and ours never touch. Every piece of text
 * from outside is set with textContent, never as markup, and a link is only
 * ever an https address the server checked. The snippet keeps the list's box
 * from the first paint, so the page doesn't jump. If the list can't be shown
 * the snippet's own plain message, with a way to reach the business, appears.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  var base = script && script.src ? new URL(script.src).origin : "";

  var CSS =
    ":host{all:initial;display:block}" +
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
    ".wrap{color:#213838}" +
    "h2{font-size:22px;line-height:1.2;margin:0 0 14px;font-weight:700}" +
    "ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}" +
    "li{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:12px 14px;border:1px solid rgba(33,56,56,.18);border-radius:3px;background:#fff}" +
    ".what{flex:1 1 220px;min-width:0}" +
    ".name{font-size:16px;font-weight:700;margin:0}" +
    ".when{font-size:14px;margin:2px 0 0;color:#4a5a5a}" +
    ".left{font-size:13px;color:#4a5a5a}.left.low{color:#a3392b;font-weight:700}" +
    "a.go{display:inline-block;padding:10px 16px;border-radius:3px;background:var(--accent);color:#213838;font-size:15px;font-weight:700;text-decoration:none}" +
    "a.go:focus-visible{outline:2px solid #213838;outline-offset:2px}" +
    ".empty{font-size:15px;margin:0;color:#4a5a5a}";

  function el(tag, props, children) {
    var node = document.createElement(tag);
    for (var key in props || {}) {
      if (key === "text") node.textContent = props[key];
      else if (props[key] !== null && props[key] !== undefined) node.setAttribute(key, props[key]);
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  function safeUrl(value) {
    if (typeof value !== "string") return null;
    try {
      var url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
    } catch (e) {
      return null;
    }
  }

  function fail(host) {
    host.classList.add("mbs-failed");
  }

  function draw(host, data) {
    var accent = /^#[0-9a-fA-F]{6}$/.test(data.accent || "") ? data.accent : "#edc2ff";
    var root = host.shadowRoot || host.attachShadow({ mode: "open" });
    root.textContent = "";
    root.appendChild(el("style", { text: CSS }));
    var list = el("ul");
    (data.classes || []).forEach(function (c) {
      var left = typeof c.seats_left === "number" ? c.seats_left : null;
      var url = safeUrl(c.url);
      list.appendChild(
        el("li", {}, [
          el("div", { class: "what" }, [
            el("p", { class: "name", text: String(c.service || "") }),
            el("p", {
              class: "when",
              text: [c.day, c.time, c.where].filter(Boolean).join(" · "),
            }),
          ]),
          left === null
            ? null
            : el("span", {
                class: left <= 2 ? "left low" : "left",
                text: left === 1 ? "1 place left" : left + " places left",
              }),
          url ? el("a", { class: "go", href: url, text: String(data.button || "Book") }) : null,
        ]),
      );
    });
    var wrap = el("div", { class: "wrap", style: "--accent:" + accent }, [
      data.title ? el("h2", { text: String(data.title) }) : null,
      (data.classes || []).length
        ? list
        : el("p", { class: "empty", text: String(data.empty_message || "") }),
    ]);
    root.appendChild(wrap);
    // The shop's own message is in the host, outside the shadow root: once the
    // list is drawn it isn't shown, as only the shadow root's content is.
  }

  function start(host) {
    if (host.getAttribute("data-mbs-started")) return;
    host.setAttribute("data-mbs-started", "1");
    var slug = host.getAttribute("data-workspace") || "";
    if (!base || !/^[a-z0-9-]{1,80}$/.test(slug)) return fail(host);
    var done = false;
    var timer = setTimeout(function () {
      if (!done) fail(host);
    }, 8000);
    fetch(base + "/api/book/upcoming?workspace=" + encodeURIComponent(slug), {
      credentials: "omit",
    })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        done = true;
        clearTimeout(timer);
        if (!data || data.found !== true) return fail(host);
        draw(host, data);
      })
      .catch(function () {
        done = true;
        clearTimeout(timer);
        fail(host);
      });
  }

  var hosts = document.querySelectorAll("[data-mbs-upcoming]");
  for (var i = 0; i < hosts.length; i++) start(hosts[i]);
})();
