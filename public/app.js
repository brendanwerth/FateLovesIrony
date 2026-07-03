/* fatelovesirony.com — shared client helpers (no framework, no build) */

const FLI = (() => {
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /* Escape, then render >greentext and >>123 references. */
  function render(content) {
    return esc(content)
      .split("\n")
      .map((line) => {
        const linked = line.replace(/&gt;&gt;(\d+)/g, '<a class="ref" href="#p$1">&gt;&gt;$1</a>');
        return /^&gt;(?!&gt;)/.test(line) ? '<span class="gt">' + linked + "</span>" : linked;
      })
      .join("\n");
  }

  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return Math.floor(s) + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  function nameHtml(p) {
    let h = '<span class="name">' + esc(p.name) + "</span>";
    if (p.trip) h += ' <span class="trip">' + esc(p.trip) + "</span>";
    return h;
  }

  function metaHtml(p) {
    return (
      '<div class="meta mono">' +
      '<span class="num">\u2116 ' + p.id + "</span>" +
      nameHtml(p) +
      '<span class="time">' + ago(p.created_at) + "</span>" +
      "</div>"
    );
  }

  /* The fuse: how far this thread is from deletion. */
  function fuseHtml(slot, capacity, total) {
    const left = capacity - slot;
    const pct = Math.min(100, Math.round((slot / capacity) * 100));
    const doomed = left < 10 && total >= capacity;
    const label = doomed
      ? "next in line for oblivion"
      : left + " until oblivion";
    return (
      '<div class="fuse mono">' +
      "<span>slot " + slot + "/" + capacity + "</span>" +
      '<span class="track" aria-hidden="true"><i style="width:' + pct + '%"></i></span>' +
      '<span class="count">' + label + "</span></div>"
    );
  }

  function isDoomed(slot, capacity, total) {
    return capacity - slot < 10 && total >= capacity;
  }

  async function api(path, opts) {
    const r = await fetch(path, opts);
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error((d && d.error) || "HTTP " + r.status);
    return d;
  }

  function post(path, body) {
    return api(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  return { esc, render, ago, nameHtml, metaHtml, fuseHtml, isDoomed, api, post };
})();
