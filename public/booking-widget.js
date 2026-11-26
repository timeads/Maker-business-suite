/*
 * The date picker for a workshop sold in a shop. It sits on the shop's
 * product page: the shopper picks a date and how many seats, and the product
 * goes into the shop's cart carrying that date. The shop takes the payment;
 * the order then arrives in the workspace as a booking.
 *
 * Plain JavaScript on purpose: no build step, no libraries, drawn inside a
 * shadow root so the shop's styles and ours never touch. Every piece of text
 * from outside is set with textContent, never as markup. It never moves the
 * page: the snippet keeps a box of the button's height from the first paint.
 * If the dates can't be shown, the shopper sees the snippet's plain message
 * and a way to reach the business, never a buy button with no date.
 */
(function () {
  "use strict";
  var script = document.currentScript;
  var base = script && script.src ? new URL(script.src).origin : "";
  var MAX_SEATS = 6;

  function el(tag, props, children) {
    var node = document.createElement(tag);
    for (var key in props || {}) {
      if (key === "text") node.textContent = props[key];
      else if (key === "on") for (var ev in props.on) node.addEventListener(ev, props.on[ev]);
      else if (props[key] !== null && props[key] !== undefined) node.setAttribute(key, props[key]);
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  var CSS =
    ":host{all:initial}" +
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}" +
    ".open{display:block;width:100%;padding:14px 18px;border:0;border-radius:3px;background:var(--accent);color:var(--ink);font-size:16px;font-weight:700;cursor:pointer;text-align:center}" +
    ".open:focus-visible,.x:focus-visible,.day:focus-visible,.time:focus-visible,.step:focus-visible,.go:focus-visible,.nav:focus-visible{outline:2px solid var(--action);outline-offset:2px}" +
    ".veil{position:fixed;inset:0;z-index:2147483000;background:rgba(33,56,56,.45);display:flex;align-items:center;justify-content:center;padding:12px}" +
    ".box{width:100%;max-width:460px;max-height:90vh;overflow:auto;background:var(--wool);color:var(--ink);border-radius:3px;padding:20px;position:relative}" +
    ".eyebrow{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0}" +
    "h2{font-size:22px;line-height:1.2;margin:4px 36px 14px 0;font-weight:700}" +
    ".x{position:absolute;top:12px;right:12px;width:32px;height:32px;border:0;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:var(--ink);border-radius:3px}" +
    ".bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-weight:700}" +
    ".nav{width:32px;height:32px;border:1px solid var(--line);background:#fff;border-radius:3px;cursor:pointer;font-size:16px;color:var(--ink)}" +
    ".nav[disabled]{opacity:.35;cursor:default}" +
    ".grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}" +
    ".dow{font-size:11px;font-weight:700;color:var(--muted);text-align:center;padding:4px 0}" +
    ".day{position:relative;aspect-ratio:1;border:1px solid transparent;border-radius:3px;background:transparent;font-size:14px;color:var(--ink);cursor:pointer}" +
    ".day[disabled]{color:#a8a0a0;cursor:default}" +
    ".day.has{background:#fff;border-color:var(--line);font-weight:700}" +
    ".day.sel{background:var(--action);border-color:var(--action);color:#fff}" +
    ".day .dot{position:absolute;left:50%;bottom:5px;width:5px;height:5px;margin-left:-2.5px;border-radius:50%;background:var(--action)}" +
    ".day .dot.off{background:#a8a0a0}.day.sel .dot{background:#fff}" +
    ".times{display:flex;flex-direction:column;gap:6px;margin-top:14px}" +
    ".time{display:flex;justify-content:space-between;gap:12px;width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:3px;background:#fff;font-size:15px;color:var(--ink);cursor:pointer;text-align:left}" +
    ".time[disabled]{opacity:.55;cursor:default}" +
    ".time.sel{border-color:var(--action);box-shadow:inset 0 0 0 1px var(--action)}" +
    ".left{color:var(--muted);font-size:13px}.left.low{color:var(--error);font-weight:700}" +
    ".note{color:var(--muted);font-size:14px;margin:14px 0 0}" +
    ".where{color:var(--muted);font-size:14px;margin:-8px 0 14px}" +
    ".err{color:var(--error);font-size:14px;margin:12px 0 0}.err a{color:var(--action)}" +
    ".foot{margin-top:16px;padding-top:14px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:12px}" +
    ".seats{display:flex;align-items:center;justify-content:space-between;font-weight:700}" +
    ".stepper{display:flex;align-items:center;gap:10px}" +
    ".step{width:36px;height:36px;border:1px solid var(--line);background:#fff;border-radius:3px;font-size:18px;cursor:pointer;color:var(--ink)}" +
    ".step[disabled]{opacity:.35;cursor:default}" +
    ".count{min-width:20px;text-align:center}" +
    ".sms{display:flex;flex-direction:column;gap:8px}" +
    ".phone{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:3px;background:#fff;font-size:15px;color:var(--ink)}" +
    ".phone:focus-visible,.tick input:focus-visible{outline:2px solid var(--action);outline-offset:2px}" +
    ".tick{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.4;color:var(--muted)}" +
    ".tick input{margin-top:2px}" +
    ".go{padding:14px 18px;border:0;border-radius:3px;background:var(--accent);color:var(--ink);font-size:16px;font-weight:700;cursor:pointer}" +
    ".go[disabled]{opacity:.6;cursor:default}" +
    "@media (max-width:640px){.veil{align-items:flex-end;padding:8px 8px 5.5rem}}" +
    "@keyframes mbs-in{from{transform:translateY(8px);opacity:0}to{transform:none;opacity:1}}" +
    "@media (prefers-reduced-motion:no-preference){.box.fresh{animation:mbs-in .16s ease-out}}";

  /*
   * The snippet marks a workshop's page by putting a plain message with a way
   * to reach the business (.mbs-fallback) inside the host, and hides the
   * theme's buy button from the first paint. If the dates can't be shown, for
   * whatever reason, that message is shown and the buy button stays hidden:
   * a workshop is never sold without a date. A host without the message is
   * an older snippet on any product page: there the page is left as the
   * theme drew it.
   */
  function failed(host) {
    if (!host.querySelector(".mbs-fallback")) return;
    host.classList.add("mbs-failed");
    var root = host.shadowRoot;
    if (!root) return;
    // Already drawn into: hand the box back to the message.
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(document.createElement("slot"));
  }

  function mount(host) {
    var slug = host.getAttribute("data-workspace") || "";
    var product = host.getAttribute("data-product-id") || "";
    if (host.shadowRoot || host.getAttribute("data-mbs-state")) return;
    if (!base || !slug || !/^[0-9]+$/.test(product)) return failed(host);
    host.setAttribute("data-mbs-state", "loading");
    var cutoff = host.getAttribute("data-cutoff-hours");
    var hideSelector = host.getAttribute("data-hide") || "";

    fetch(base + "/api/book/shop?workspace=" + encodeURIComponent(slug) + "&product=" + product)
      .then(function (res) {
        if (!res.ok) throw new Error("dates");
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.found) throw new Error("none");
        var page = data.page || {};
        // The snippet's own number wins, for snippets pasted before this was a setting.
        var hours = cutoff === null || cutoff === "" ? page.cutoff_hours : cutoff;
        start(host, data, Number(hours) || 0, hideSelector);
        host.setAttribute("data-mbs-state", "ready");
      })
      .catch(function () {
        host.setAttribute("data-mbs-state", "failed");
        failed(host);
      });
  }

  function start(host, data, cutoffHours, hideSelector) {
    var zone = data.workspace.timezone;
    var fmt = function (opts) {
      return new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: zone }, opts));
    };
    var dayKey = function (date) {
      return fmt({ year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(date)
        .filter(function (p) {
          return p.type !== "literal";
        })
        .reduce(function (o, p) {
          o[p.type] = p.value;
          return o;
        }, {});
    };
    var keyOf = function (date) {
      var k = dayKey(date);
      return k.year + "-" + k.month + "-" + k.day;
    };
    // "1:00 PM ET": the label comes with each date, worked out for the
    // workspace's own clock. Without one, the browser's short name stands in.
    var timeOf = function (date, zoneName) {
      return zoneName
        ? fmt({ hour: "numeric", minute: "2-digit" }).format(date) + " " + zoneName
        : fmt({ hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date);
    };
    var longDay = function (date) {
      return fmt({ weekday: "long", month: "short", day: "numeric", year: "numeric" }).format(date);
    };
    // Where a shopper can turn if the cart won't take the booking: only ever
    // a web page or an email address the business gave.
    var page = data.page || {};
    var contact = /^https:\/\//.test(page.contact_url || "")
      ? page.contact_url
      : /^[^\s@]+@[^\s@]+$/.test(page.contact_email || "")
        ? "mailto:" + page.contact_email
        : "";
    var now = Date.now();
    var sessions = data.sessions.map(function (s) {
      var at = new Date(s.starts_at);
      var closed = at.getTime() - now < cutoffHours * 3600000;
      return {
        id: s.id,
        at: at,
        zone: typeof s.zone === "string" ? s.zone.slice(0, 12) : "",
        key: keyOf(at),
        left: s.seats_left,
        closed: closed,
        open: !closed && s.seats_left > 0,
      };
    });
    var byDay = {};
    sessions.forEach(function (s) {
      (byDay[s.key] = byDay[s.key] || []).push(s);
    });

    // The theme's own buy button would add the workshop without a date.
    try {
      var own = host.closest("form[action*='/cart/add']");
      var targets = hideSelector
        ? document.querySelectorAll(hideSelector)
        : own
          ? own.querySelectorAll("[type='submit'], .shopify-payment-button")
          : [];
      targets.forEach(function (node) {
        node.style.display = "none";
      });
    } catch {
      /* A selector the browser doesn't like changes nothing. */
    }
    var root = host.attachShadow({ mode: "open" });
    var accent = /^#[0-9a-fA-F]{6}$/.test(host.getAttribute("data-accent") || "")
      ? host.getAttribute("data-accent")
      : "#edc2ff";
    var wrap = el("div", {
      style:
        "--accent:" +
        accent +
        ";--ink:#213838;--action:#0051ff;--muted:#4c444d;--line:#d8cfc9;--wool:#f5edeb;--error:#ba1a1a",
    });
    root.appendChild(el("style", { text: CSS }));
    root.appendChild(wrap);

    var state = {
      open: false,
      month: null,
      day: null,
      pick: null,
      seats: 1,
      busy: false,
      error: "",
      // Text reminders, only where the business offers them.
      phone: "",
      agree: false,
    };
    var texts = data.texts && data.texts.asked ? data.texts : null;
    var first =
      sessions.filter(function (s) {
        return s.open;
      })[0] || sessions[0];
    var today = keyOf(new Date());
    state.month = (first ? first.key : today).slice(0, 7);
    var lastFocus = null;

    function label() {
      if (!state.pick) return "Choose your date";
      return (
        fmt({ month: "short", day: "numeric" }).format(state.pick.at) +
        " · " +
        timeOf(state.pick.at, state.pick.zone) +
        " · " +
        state.seats +
        (state.seats === 1 ? " seat" : " seats") +
        " — change"
      );
    }

    function monthDays(month) {
      var y = Number(month.slice(0, 4));
      var m = Number(month.slice(5, 7));
      var lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
      var count = new Date(Date.UTC(y, m, 0)).getUTCDate();
      var cells = [];
      for (var i = 0; i < lead; i++) cells.push(null);
      for (var d = 1; d <= count; d++) cells.push(month + "-" + (d < 10 ? "0" + d : d));
      return cells;
    }
    function shift(month, by) {
      var y = Number(month.slice(0, 4));
      var m = Number(month.slice(5, 7)) - 1 + by;
      var date = new Date(Date.UTC(y, m, 1));
      return date.getUTCFullYear() + "-" + ("0" + (date.getUTCMonth() + 1)).slice(-2);
    }
    function monthName(month) {
      return new Intl.DateTimeFormat("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(month + "-01T12:00:00Z"));
    }

    function close() {
      state.open = false;
      draw();
      if (lastFocus) lastFocus.focus();
    }

    function confirm() {
      if (!state.pick || state.busy) return;
      var variant = data.service.variant_id;
      if (!variant) {
        var input = document.querySelector("form[action*='/cart/add'] [name='id']");
        variant = input ? input.value : "";
      }
      if (!variant) {
        state.error =
          "We couldn't add this to your cart. Please get in touch and we'll book you in.";
        return draw();
      }
      var phone = texts ? state.phone.trim().slice(0, 40) : "";
      if (texts && state.agree && !phone) {
        state.error = "To get texts, add your mobile number, or untick the box.";
        return draw();
      }
      var properties = {
        "Session ID": state.pick.id,
        "Workshop Date": longDay(state.pick.at),
        "Workshop Time": timeOf(state.pick.at, state.pick.zone),
      };
      // Names starting with "_" go with the order but are hidden at checkout.
      if (phone) {
        properties._text_phone = phone;
        if (state.agree) properties._text_consent = "yes";
      }
      state.busy = true;
      state.error = "";
      draw();
      fetch("/cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          id: Number(variant),
          quantity: state.seats,
          properties: properties,
        }),
      })
        .then(function (res) {
          if (!res.ok) throw new Error("cart");
          window.location.assign("/cart");
        })
        .catch(function () {
          state.busy = false;
          state.error =
            "We couldn't add this to your cart. Please try again, or get in touch and we'll book you in.";
          draw();
        });
    }

    function draw() {
      var held = root.activeElement ? root.activeElement.getAttribute("data-k") : null;
      while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
      wrap.appendChild(
        el("button", {
          type: "button",
          class: "open",
          text: label(),
          "aria-haspopup": "dialog",
          on: {
            click: function (e) {
              lastFocus = e.currentTarget;
              state.open = true;
              state.fresh = true;
              draw();
            },
          },
        }),
      );
      if (!state.open) return;

      var cells = monthDays(state.month).map(function (key) {
        if (!key) return el("span", {});
        var list = byDay[key] || [];
        var bookable = list.some(function (s) {
          return s.open;
        });
        var btn = el(
          "button",
          {
            type: "button",
            class: "day" + (list.length ? " has" : "") + (state.day === key ? " sel" : ""),
            "data-k": "d" + key,
            disabled: list.length && key >= today ? null : "",
            "aria-pressed": state.day === key ? "true" : "false",
            "aria-label":
              new Intl.DateTimeFormat("en-US", {
                month: "long",
                day: "numeric",
                timeZone: "UTC",
              }).format(new Date(key + "T12:00:00Z")) +
              (list.length ? (bookable ? ", dates available" : ", fully booked") : ""),
            text: String(Number(key.slice(8))),
            on: {
              click: function () {
                state.day = key;
                state.pick = null;
                state.seats = 1;
                draw();
              },
            },
          },
          [],
        );
        if (list.length) btn.appendChild(el("span", { class: "dot" + (bookable ? "" : " off") }));
        return btn;
      });

      var times = (byDay[state.day] || []).map(function (s) {
        var words = s.closed
          ? "Closed"
          : s.left <= 0
            ? "Sold out"
            : s.left + (s.left === 1 ? " seat left" : " seats left");
        return el(
          "button",
          {
            type: "button",
            class: "time" + (state.pick && state.pick.id === s.id ? " sel" : ""),
            "data-k": "t" + s.id,
            disabled: s.open ? null : "",
            "aria-pressed": state.pick && state.pick.id === s.id ? "true" : "false",
            on: {
              click: function () {
                state.pick = s;
                state.seats = Math.min(state.seats, Math.min(s.left, MAX_SEATS));
                draw();
              },
            },
          },
          [
            el("span", { text: timeOf(s.at, s.zone) }),
            el("span", { class: "left" + (s.open && s.left <= 3 ? " low" : ""), text: words }),
          ],
        );
      });

      var max = state.pick ? Math.min(state.pick.left, MAX_SEATS) : 1;
      var foot = state.pick
        ? el("div", { class: "foot" }, [
            el("div", { class: "seats" }, [
              el("span", { text: "Seats" }),
              el("span", { class: "stepper" }, [
                el("button", {
                  type: "button",
                  class: "step",
                  text: "−",
                  "data-k": "minus",
                  "aria-label": "One seat fewer",
                  disabled: state.seats <= 1 ? "" : null,
                  on: {
                    click: function () {
                      state.seats = Math.max(1, state.seats - 1);
                      draw();
                    },
                  },
                }),
                el("span", { class: "count", "aria-live": "polite", text: String(state.seats) }),
                el("button", {
                  type: "button",
                  class: "step",
                  text: "+",
                  "data-k": "plus",
                  "aria-label": "One more seat",
                  disabled: state.seats >= max ? "" : null,
                  on: {
                    click: function () {
                      state.seats = Math.min(max, state.seats + 1);
                      draw();
                    },
                  },
                }),
              ]),
            ]),
            texts
              ? el("div", { class: "sms" }, [
                  el("input", {
                    type: "tel",
                    class: "phone",
                    "data-k": "phone",
                    placeholder: "Mobile number (optional)",
                    autocomplete: "tel",
                    maxlength: "40",
                    "aria-label": "Mobile number (optional)",
                    value: state.phone,
                    on: {
                      input: function (e) {
                        state.phone = e.target.value;
                      },
                    },
                  }),
                  el("label", { class: "tick" }, [
                    el("input", {
                      type: "checkbox",
                      "data-k": "agree",
                      checked: state.agree ? "" : null,
                      on: {
                        change: function (e) {
                          state.agree = e.target.checked;
                        },
                      },
                    }),
                    el("span", { text: texts.consent }),
                  ]),
                ])
              : null,
            el("button", {
              type: "button",
              class: "go",
              "data-k": "go",
              disabled: state.busy ? "" : null,
              text: state.busy
                ? "Adding…"
                : "Confirm · " + state.seats + (state.seats === 1 ? " seat" : " seats"),
              on: { click: confirm },
            }),
          ])
        : null;

      var canGoBack = state.month > today.slice(0, 7);
      var box = el(
        "div",
        {
          class: "box" + (state.fresh ? " fresh" : ""),
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "Choose your date",
        },
        [
          el("button", {
            type: "button",
            class: "x",
            text: "×",
            "aria-label": "Close",
            on: { click: close },
          }),
          el("p", { class: "eyebrow", text: "Choose your date" }),
          el("h2", { text: data.service.name }),
          data.service.location ? el("p", { class: "where", text: data.service.location }) : null,
          sessions.length === 0
            ? el("p", { class: "note", text: "No upcoming dates right now — check back soon!" })
            : el("div", {}, [
                el("div", { class: "bar" }, [
                  el("button", {
                    type: "button",
                    class: "nav",
                    text: "‹",
                    "data-k": "prev",
                    "aria-label": "Earlier month",
                    disabled: canGoBack ? null : "",
                    on: {
                      click: function () {
                        state.month = shift(state.month, -1);
                        draw();
                      },
                    },
                  }),
                  el("span", { "aria-live": "polite", text: monthName(state.month) }),
                  el("button", {
                    type: "button",
                    class: "nav",
                    text: "›",
                    "data-k": "next",
                    "aria-label": "Later month",
                    on: {
                      click: function () {
                        state.month = shift(state.month, 1);
                        draw();
                      },
                    },
                  }),
                ]),
                el(
                  "div",
                  { class: "grid" },
                  ["S", "M", "T", "W", "T", "F", "S"]
                    .map(function (d) {
                      return el("span", { class: "dow", text: d, "aria-hidden": "true" });
                    })
                    .concat(cells),
                ),
                state.day
                  ? el(
                      "div",
                      { class: "times" },
                      times.length
                        ? times
                        : [el("p", { class: "note", text: "No sessions this day." })],
                    )
                  : el("p", { class: "note", text: "Pick a day with a dot to see its times." }),
              ]),
          state.error
            ? el("p", { class: "err", role: "alert" }, [
                el("span", { text: state.error + " " }),
                contact ? el("a", { href: contact, text: "Contact us" }) : null,
              ])
            : null,
          foot,
        ],
      );
      var veil = el(
        "div",
        {
          class: "veil",
          on: {
            click: function (e) {
              if (e.target === veil) close();
            },
            keydown: function (e) {
              if (e.key === "Escape") close();
              if (e.key !== "Tab") return;
              // Keep the keyboard inside the picker while it is open.
              var stops = box.querySelectorAll("button:not([disabled])");
              if (!stops.length) return;
              var firstStop = stops[0];
              var lastStop = stops[stops.length - 1];
              if (e.shiftKey && root.activeElement === firstStop) {
                e.preventDefault();
                lastStop.focus();
              } else if (!e.shiftKey && root.activeElement === lastStop) {
                e.preventDefault();
                firstStop.focus();
              }
            },
          },
        },
        [box],
      );
      state.fresh = false;
      wrap.appendChild(veil);
      // Stay on the control that was just used; on opening, start at the top.
      var keep =
        (held && box.querySelector('[data-k="' + held + '"]:not([disabled])')) ||
        box.querySelector(".x");
      if (keep) keep.focus();
    }

    draw();
  }

  function mountAll() {
    document.querySelectorAll("[data-mbs-booking]").forEach(mount);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAll);
  else mountAll();
  window.MBSBooking = { mount: mount };
})();
