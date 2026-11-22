/*
 * Maker Business Suite booking embed.
 *
 *   <div data-maker-booking="your-workspace"></div>
 *   <script src="https://<site>/embed.js" async></script>
 *
 * Add data-service="service-name" to open one service directly.
 */
(function () {
  var script = document.currentScript;
  var origin = script ? new URL(script.src).origin : "";
  var nodes = document.querySelectorAll("[data-maker-booking]:not([data-maker-ready])");
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var slug = node.getAttribute("data-maker-booking");
    if (!/^[a-z0-9-]+$/.test(slug || "")) continue;
    var service = node.getAttribute("data-service");
    var path = "/book/" + slug + (service && /^[a-z0-9-]+$/.test(service) ? "/" + service : "");
    var frame = document.createElement("iframe");
    frame.src = origin + path + "?embed=1";
    frame.title = "Book online";
    frame.loading = "lazy";
    frame.style.cssText = "width:100%;min-height:720px;border:0;";
    node.setAttribute("data-maker-ready", "1");
    node.appendChild(frame);
  }
})();
