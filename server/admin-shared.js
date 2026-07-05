// BookAndBuy Admin – gemeinsame Helfer aller Admin-Seiten
const $ = (id) => document.getElementById(id);

const api = async (path, opts) => {
  // relative Pfade, damit die UI auch hinter /admin/ (Reverse-Proxy) funktioniert
  const res = await fetch(path.replace(/^\//, ""), opts && {
    method: opts.method || "POST",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
  return res.json();
};

const AMAZON_TAG = "smarteshome-21";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const asinImg = (asin) =>
  `https://images-eu.ssl-images-amazon.com/images/P/${encodeURIComponent(asin)}.03._SL250_.jpg`;
const prodImg = (p) => p.image || (p.asin ? asinImg(p.asin) : null);

// Header-Navigation einheitlich rendern; `active` = Seiten-Key
function renderNav(active) {
  const pages = [
    ["dashboard", "./", "Inhalte"],
    ["produkte", "./produkte", "Live-Produkte"],
    ["statistik", "./statistik", "Statistik"],
  ];
  return `<nav class="adminnav">${pages
    .map(([key, href, label]) =>
      `<a href="${href}" class="${key === active ? "active" : ""}">${label}</a>`)
    .join("")}</nav>`;
}

// Publish-Button + -Status (auf allen Seiten im Header)
async function refreshPublishStatus() {
  try {
    const s = await api("/api/status", { method: "GET" });
    const p = s.publish;
    if ($("pub-status")) {
      $("pub-status").innerHTML = p.running
        ? '<span class="spinner"></span> Build läuft …'
        : p.ok === true ? "Build ✅" : p.ok === false ? "Build ❌" : "";
      $("pub-status").title = p.output || "";
    }
    if ($("btn-publish")) $("btn-publish").disabled = p.running;
    return s;
  } catch { return null; }
}

function wirePublishButton(afterPoll) {
  const btn = $("btn-publish");
  if (!btn) return;
  btn.onclick = async () => {
    await api("/api/publish", { body: {} });
    const poll = async () => {
      const s = await refreshPublishStatus();
      if (s && s.publish.running) setTimeout(poll, 2000);
      else if (afterPoll) afterPoll();
    };
    poll();
  };
}
