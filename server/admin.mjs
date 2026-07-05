#!/usr/bin/env node
// BookAndBuy Admin-Server: lokale UI + API für die Content-Pipeline.
//
//   node server/admin.mjs          → http://localhost:4321 ... nein: 5177
//
// Funktionen:
//   - Discovery-Lauf starten (Google-Suggest-Harvest) → Vorschlagsliste
//   - Pro Vorschlag per Azure OpenAI einen Kategorie-Entwurf generieren
//   - Entwürfe reviewen, freigeben (→ data/categories/) oder verwerfen
//
// Nur ein Node-Prozess, keine Framework-Dependencies.

import { createServer } from "node:http";
import { readFile, writeFile, mkdir, appendFile, open, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadEnv, ROOT } from "./lib/env.mjs";
import { runDiscovery } from "./lib/discovery.mjs";
import {
  generateDraft, listDrafts, getDraft, saveDraft,
  approveDraft, rejectDraft,
} from "./lib/generator.mjs";
import { llmConfigured } from "./lib/llm.mjs";
import { verifyProducts } from "./lib/asin.mjs";

loadEnv();

const PORT = Number(process.env.ADMIN_PORT || 5177);
const HOST = process.env.ADMIN_HOST || "127.0.0.1";
const SUGGESTIONS_FILE = join(ROOT, "data", "suggestions.json");
const SETTINGS_FILE = join(ROOT, "data", "settings.json");
const DRAFT_LOG_FILE = join(ROOT, "data", "draft-log.json");
const CATEGORIES_DIR = join(ROOT, "data", "categories");
const execFileAsync = promisify(execFile);

// Statische Admin-Seiten & -Assets (nur Whitelist, kein Verzeichnis-Listing)
const ADMIN_PAGES = {
  "/": ["admin-ui.html", "text/html"],
  "/produkte": ["admin-produkte.html", "text/html"],
  "/statistik": ["admin-statistik.html", "text/html"],
  "/admin-ui.css": ["admin-ui.css", "text/css"],
  "/admin-shared.js": ["admin-shared.js", "text/javascript"],
};

// ---------------------------------------------------------------- Zustand
const state = {
  discovery: { running: false, progress: "", startedAt: null, finishedAt: null },
  generating: new Set(), // Begriffe, für die gerade ein Entwurf erzeugt wird
  publish: { running: false, ok: null, output: "", finishedAt: null },
  autoDrafting: false,
  bulkDraft: { running: false, progress: "", done: 0, total: 0, errors: 0 },
  recheck: {
    running: false, progress: "", nextAt: null,
    lastFinishedAt: null, lastSummary: "",
  },
};

// --------------------------------------------------------- Einstellungen
const DEFAULT_SETTINGS = { recheckHours: 12 };

async function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(SETTINGS_FILE, "utf8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(s) {
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2), "utf8");
}

async function loadSuggestions() {
  try {
    return JSON.parse(await readFile(SUGGESTIONS_FILE, "utf8"));
  } catch {
    return { updatedAt: null, items: [] };
  }
}

async function saveSuggestions(data) {
  await mkdir(join(ROOT, "data"), { recursive: true });
  await writeFile(SUGGESTIONS_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function startDiscovery() {
  if (state.discovery.running) return;
  state.discovery = {
    running: true, progress: "gestartet …",
    startedAt: new Date().toISOString(), finishedAt: null,
  };
  try {
    const items = await runDiscovery((msg) => (state.discovery.progress = msg));
    const prev = await loadSuggestions();
    const dismissed = new Set(
      prev.items.filter((i) => i.dismissed).map((i) => i.term)
    );
    // Hit-Verlauf pro Begriff fortschreiben (max. 14 Tage) → Trend-Richtung
    const prevByTerm = new Map(prev.items.map((i) => [i.term, i]));
    const today = new Date().toISOString().slice(0, 10);
    await saveSuggestions({
      updatedAt: new Date().toISOString(),
      items: items.map((i) => {
        const p = prevByTerm.get(i.term);
        const history = (p?.history ?? [])
          .filter((h) => h.date !== today)
          .slice(-13);
        history.push({ date: today, hits: i.hits });
        const prevHits = history.length >= 2 ? history[history.length - 2].hits : null;
        return {
          ...i,
          dismissed: dismissed.has(i.term),
          history,
          delta: prevHits == null ? null : i.hits - prevHits,
        };
      }),
    });
    state.discovery.progress = `fertig: ${items.length} Vorschläge`;
  } catch (e) {
    state.discovery.progress = `Fehler: ${e.message}`;
  } finally {
    state.discovery.running = false;
    state.discovery.finishedAt = new Date().toISOString();
  }
}

// ------------------------------------------------- IndexNow (Bing & Co.)
const INDEXNOW_KEY = "3b578052369d459bafdf74ec7773ea69";
const SITE_URL = "https://www.bookandbuy.de";

async function notifyIndexNow() {
  try {
    const files = await readdir(CATEGORIES_DIR).catch(() => []);
    const urlList = [
      `${SITE_URL}/`,
      ...files
        .filter((f) => f.endsWith(".json"))
        .flatMap((f) => {
          const slug = f.replace(/\.json$/, "");
          return [`${SITE_URL}/${slug}/`, `${SITE_URL}/daten/${slug}.json`];
        }),
    ];
    await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: "www.bookandbuy.de",
        key: INDEXNOW_KEY,
        keyLocation: `${SITE_URL}/${INDEXNOW_KEY}.txt`,
        urlList,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* nicht kritisch */
  }
}

// ------------------------------------------------- Bluesky (Auto-Post)
// Postet bei Freigabe einer NEUEN Kategorie einen Hinweis mit Link.
// Credentials in .env: BLUESKY_HANDLE + BLUESKY_APP_PASSWORD.
async function notifyBluesky(slug) {
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) return;
  try {
    const cat = JSON.parse(
      await readFile(join(CATEGORIES_DIR, `${slug}.json`), "utf8")
    );
    const name =
      (cat.name || slug).replace(/\s*(im\s+)?Vergleich(\s+\d{4})?\s*$/i, "").trim() ||
      cat.name;
    const prices = (cat.products || [])
      .map((p) => p?.price?.value)
      .filter((v) => typeof v === "number");
    const min = prices.length ? Math.min(...prices) : null;
    const url = `${SITE_URL}/${slug}/`;
    const text =
      `Neu im Vergleich: ${name} – ${cat.products.length} Modelle` +
      (min != null ? ` ab ${min.toLocaleString("de-DE")} €` : "") +
      `, täglich preisgeprüft.\n\n${url}`;
    const loginRes = await fetch(
      "https://bsky.social/xrpc/com.atproto.server.createSession",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: handle, password }),
        signal: AbortSignal.timeout(10_000),
      }
    );
    const session = await loginRes.json();
    if (!session.accessJwt)
      throw new Error(session.message || "Login fehlgeschlagen");

    // Produktbild → Blob hochladen → Link-Karte mit Thumbnail.
    // Alle Produkte durchprobieren und das GRÖSSTE brauchbare Bild nehmen –
    // ungültige ASINs liefern beim Amazon-CDN nur ein 43-Byte-GIF, manche
    // Produkte nur Mini-Bilder (wenige KB), die auf der Karte unscharf wirken.
    let thumb = null;
    try {
      let best = null; // { buf, type }
      for (const p of cat.products || []) {
        if (!p.image && !p.asin) continue;
        const imgUrl =
          p.image ||
          `https://images-eu.ssl-images-amazon.com/images/P/${p.asin}.03._SL500_.jpg`;
        const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
        if (!imgRes?.ok) continue;
        const buf = Buffer.from(await imgRes.arrayBuffer());
        if (buf.length < 1000 || buf.length > 950_000) continue;
        if (!best || buf.length > best.buf.length)
          best = { buf, type: imgRes.headers.get("content-type") || "image/jpeg" };
        if (best.buf.length > 30_000) break; // groß genug → nicht weiter suchen
      }
      if (best) {
        const upRes = await fetch(
          "https://bsky.social/xrpc/com.atproto.repo.uploadBlob",
          {
            method: "POST",
            headers: {
              "Content-Type": best.type,
              Authorization: `Bearer ${session.accessJwt}`,
            },
            body: best.buf,
            signal: AbortSignal.timeout(15_000),
          }
        );
        if (upRes.ok) thumb = (await upRes.json()).blob;
      }
    } catch {
      /* ohne Bild weiter */
    }

    // Link-Karte (external embed); Link zusätzlich als Facet klickbar.
    const byteEnd = Buffer.byteLength(text);
    const byteStart = byteEnd - Buffer.byteLength(url);
    const record = {
      $type: "app.bsky.feed.post",
      text,
      createdAt: new Date().toISOString(),
      langs: ["de"],
      facets: [
        {
          index: { byteStart, byteEnd },
          features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
        },
      ],
      embed: {
        $type: "app.bsky.embed.external",
        external: {
          uri: url,
          title: `${name} im Vergleich – BookAndBuy`,
          description: cat.intro || "",
          ...(thumb ? { thumb } : {}),
        },
      },
    };
    const postRes = await fetch(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.accessJwt}`,
        },
        body: JSON.stringify({
          repo: session.did,
          collection: "app.bsky.feed.post",
          record,
        }),
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!postRes.ok) throw new Error(`HTTP ${postRes.status}`);
    console.log(`Bluesky: Post für /${slug}/ abgesetzt${thumb ? " (mit Bild)" : ""}`);
  } catch (e) {
    console.error(`Bluesky-Post fehlgeschlagen (${slug}): ${e.message}`);
  }
}

// ------------------------------------------------------- Publish (Build)
async function runPublish(announceSlug) {
  if (state.publish.running) return;
  state.publish = { running: true, ok: null, output: "baue …", finishedAt: null };
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [join(ROOT, "node_modules", "astro", "astro.js"), "build"],
      {
        cwd: ROOT, timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024,
        // Telemetry will nach ~/.config schreiben → scheitert an der
        // systemd-Sandbox (ProtectHome). Deshalb hart deaktivieren.
        env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
      }
    );
    state.publish.ok = true;
    state.publish.output = (stdout + stderr).split("\n").slice(-6).join("\n");
    notifyIndexNow(); // Suchmaschinen (Bing & Co.) über neue Inhalte informieren
    if (announceSlug) notifyBluesky(announceSlug); // neue Kategorie ankündigen
  } catch (e) {
    state.publish.ok = false;
    state.publish.output = String(e.message).slice(0, 800);
  } finally {
    state.publish.running = false;
    state.publish.finishedAt = new Date().toISOString();
  }
}

// ------------------------------------- Auto-Pilot (täglicher Scheduler)
// Läuft jede Nacht: NUR Discovery (Vorschläge sammeln). Entwürfe werden
// ausschließlich manuell erzeugt – mit 24h-Drossel pro Begriff.
const AUTO_HOUR = Number(process.env.AUTO_HOUR ?? 5); // 05:00 Serverzeit

// Lädt Kurz-Infos aller Live-Kategorien (für den dynamischen Abgleich
// der Vorschlagsliste – der „covered“-Flag aus der Discovery veraltet,
// sobald danach neue Kategorien live gehen).
async function loadLiveCategories() {
  const files = (await readdir(CATEGORIES_DIR).catch(() => [])).filter((f) => f.endsWith(".json"));
  const cats = [];
  for (const f of files) {
    try {
      const d = JSON.parse(await readFile(join(CATEGORIES_DIR, f), "utf8"));
      cats.push({ slug: d.slug, name: d.name || "", terms: d.terms || [] });
    } catch { /* defekte Datei ignorieren */ }
  }
  return cats;
}

// Normalisiert Begriffe/Namen/Slugs für unscharfes Matching:
// Kleinschreibung, Umlaute transliteriert (ö→oe …), Rest zu Bindestrichen.
// Wichtig: Live-Slugs sind ASCII („in-ear-kopfhoerer“), Suchbegriffe nicht
// („in ear kopfhörer“) – ohne Transliteration matcht das nie.
function normTerm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Ordnet einem Suchbegriff eine evtl. vorhandene Live-Kategorie zu
// (gleiche unscharfe Logik wie isCovered in der Discovery).
function findLiveForTerm(term, cats) {
  const g = normTerm(term);
  if (!g) return null;
  return (
    cats.find((c) => {
      const slug = normTerm(c.slug);
      const name = normTerm(c.name);
      return (
        slug.includes(g) ||
        g.includes(slug) ||
        (name && (name.includes(g) || g.includes(name))) ||
        c.terms.some((x) => {
          const nx = normTerm(x);
          return nx && (nx.includes(g) || g.includes(nx));
        })
      );
    }) || null
  );
}

// Ordnet einem Suchbegriff einen evtl. vorhandenen Entwurf zu.
// Exakt über sourceTerm, sonst unscharf über den Slug (Alt-Entwürfe).
function findDraftForTerm(term, drafts) {
  const t = term.toLowerCase();
  const exact = drafts.find((d) => (d.sourceTerm || "").toLowerCase() === t);
  if (exact) return exact;
  const g = normTerm(term);
  if (!g) return null;
  return drafts.find((d) => d.slug.includes(g) || g.includes(d.slug)) || null;
}

// ------------------------- Draft-Log: max. 1 Entwurf pro Begriff pro 24 h
// Verhindert, dass Bulk/Auto-Läufe denselben Begriff mehrfach am Tag
// generieren (Kosten + Durcheinander). Manuelles Erzeugen bleibt erlaubt,
// wird aber ebenfalls protokolliert.
async function loadDraftLog() {
  try {
    return JSON.parse(await readFile(DRAFT_LOG_FILE, "utf8"));
  } catch {
    return {};
  }
}
async function markDrafted(term) {
  const log = await loadDraftLog();
  log[term.toLowerCase()] = new Date().toISOString();
  await writeFile(DRAFT_LOG_FILE, JSON.stringify(log, null, 2), "utf8");
}
function draftedRecently(log, term) {
  const at = log[term.toLowerCase()];
  return at && Date.now() - Date.parse(at) < 24 * 60 * 60 * 1000;
}

// Bulk-Generierung (NUR manuell per Button): für alle offenen Vorschläge
// (nicht live, nicht verworfen, ohne Entwurf, heute noch nicht generiert)
// sequenziell Entwürfe erzeugen.
async function runBulkDrafts() {
  if (!llmConfigured() || state.bulkDraft.running) return;
  const data = await loadSuggestions();
  const drafts = await listDrafts();
  const live = await loadLiveCategories();
  const log = await loadDraftLog();
  const todo = data.items
    .filter(
      (i) =>
        !i.covered &&
        !i.dismissed &&
        !findLiveForTerm(i.term, live) && // schon live → kein Duplikat erzeugen
        !findDraftForTerm(i.term, drafts) &&
        !draftedRecently(log, i.term) // 24h-Drossel
    )
    .sort((a, b) => b.hits - a.hits);
  state.bulkDraft = { running: true, progress: "", done: 0, total: todo.length, errors: 0 };
  try {
    for (const c of todo) {
      state.bulkDraft.progress = `${state.bulkDraft.done + 1}/${todo.length}: ${c.term}`;
      await markDrafted(c.term); // auch bei Fehlern nicht am selben Tag erneut
      try {
        const draft = await generateDraft(c.term);
        console.log(`[bulk] Entwurf erzeugt: ${draft.slug}`);
      } catch (e) {
        state.bulkDraft.errors++;
        console.error(`[bulk] Entwurf fehlgeschlagen (${c.term}): ${e.message}`);
      }
      state.bulkDraft.done++;
    }
    state.bulkDraft.progress = `fertig: ${state.bulkDraft.done} Entwürfe, ${state.bulkDraft.errors} Fehler`;
  } finally {
    state.bulkDraft.running = false;
  }
}

function scheduleAutoPilot() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(AUTO_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next - now;
  setTimeout(async () => {
    // Nur Discovery – Entwürfe werden bewusst NICHT mehr automatisch
    // erzeugt (nur manuell per Button, mit 24h-Drossel pro Begriff).
    console.log("[auto] Nächtlicher Lauf: Discovery");
    await startDiscovery();
    scheduleAutoPilot();
  }, ms);
  console.log(`[auto] Nächster automatischer Lauf: ${next.toISOString()}`);
}

// ------------------------------- Recheck-Scheduler (Live-Kategorien)
// Prüft periodisch die ASINs aller Live-Kategorien (Bild-CDN, bei Fehlern
// Korrektur über die Amazon-Suche). Intervall via data/settings.json
// (recheckHours, 0 = aus) – im Admin einstellbar. Bei Korrekturen wird
// automatisch neu gebaut.
let recheckTimer = null;

async function runRecheck() {
  if (state.recheck.running) return;
  state.recheck.running = true;
  state.recheck.progress = "gestartet …";
  let changed = 0, checked = 0, problems = 0;
  try {
    const files = (await readdir(CATEGORIES_DIR).catch(() => []))
      .filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const file = join(CATEGORIES_DIR, f);
      const data = JSON.parse(await readFile(file, "utf8"));
      state.recheck.progress = `prüfe ${data.slug} …`;
      const report = await verifyProducts(data.products, (msg) => {
        state.recheck.progress = `${data.slug}: ${msg}`;
      });
      checked += report.length;
      changed += report.filter((e) => e.status === "korrigiert").length;
      problems += report.filter((e) => e.status !== "ok" && e.status !== "korrigiert").length;
      data.asinReport = report;
      await writeFile(file, JSON.stringify(data, null, 2), "utf8");
    }
    state.recheck.lastSummary =
      `${checked} Produkte geprüft, ${changed} korrigiert, ${problems} Probleme`;
    if (changed > 0) runPublish(); // korrigierte Daten → Site neu bauen
  } catch (e) {
    state.recheck.lastSummary = `Fehler: ${e.message}`;
  } finally {
    state.recheck.running = false;
    state.recheck.progress = "";
    state.recheck.lastFinishedAt = new Date().toISOString();
  }
}

async function scheduleRecheck() {
  clearTimeout(recheckTimer);
  const { recheckHours } = await loadSettings();
  if (!recheckHours || recheckHours <= 0) {
    state.recheck.nextAt = null;
    console.log("[recheck] deaktiviert (recheckHours=0)");
    return;
  }
  const ms = recheckHours * 3600_000;
  state.recheck.nextAt = new Date(Date.now() + ms).toISOString();
  recheckTimer = setTimeout(async () => {
    console.log("[recheck] Periodischer Lauf startet");
    await runRecheck();
    scheduleRecheck();
  }, ms);
  console.log(`[recheck] Nächster Lauf: ${state.recheck.nextAt} (alle ${recheckHours} h)`);
}

// ------------------------------------------------------ Tracking & Stats
// Klicks: JSONL-Log (data/clicks.jsonl), gespeist vom /t-Beacon der Site.
// LLM-Crawler: Auswertung des Caddy-Access-Logs nach bekannten Bot-UAs.
const CLICKS_FILE = join(ROOT, "data", "clicks.jsonl");
const ACCESS_LOG = process.env.CADDY_ACCESS_LOG || "/var/log/caddy/access.log";

const LLM_BOTS = [
  ["GPTBot", /GPTBot/i],
  ["OAI-SearchBot", /OAI-SearchBot/i],
  ["ChatGPT-User", /ChatGPT-User/i],
  ["ClaudeBot", /ClaudeBot|Claude-Web|anthropic/i],
  ["PerplexityBot", /PerplexityBot|Perplexity-User/i],
  ["Google-Extended", /Google-Extended/i],
  ["GoogleOther", /GoogleOther/i],
  ["BingBot", /bingbot/i],
  ["Amazonbot", /Amazonbot/i],
  ["Meta", /meta-externalagent|FacebookBot/i],
  ["Bytespider", /Bytespider/i],
  ["CCBot", /CCBot/i],
  ["Applebot", /Applebot/i],
  ["MistralAI", /MistralAI/i],
  ["Cohere", /cohere/i],
];

// Generische Bots/Skripte (zusätzlich zu den LLM-Crawlern oben).
const GENERIC_BOT_RE = /bot|crawl|spider|slurp|scan|probe|fetch|monitor|pingdom|uptime|curl|wget|python|go-http|node-fetch|axios|okhttp|java\/|libwww|headless|phantom|lighthouse|facebookexternalhit|preview|feedly|rss/i;

// UA klassifizieren: bekannter LLM-Crawler, sonstiger Bot oder echter Besucher.
function classifyUa(ua) {
  const llm = LLM_BOTS.find(([, re]) => re.test(ua));
  if (llm) return { type: "bot", name: llm[0] };
  if (!ua) return { type: "bot", name: "ohne User-Agent" };
  if (GENERIC_BOT_RE.test(ua)) {
    const m = ua.match(/([a-z0-9._-]*(?:bot|crawler|spider|scan)[a-z0-9._-]*)/i);
    return { type: "bot", name: (m ? m[1] : ua.split(/[\s/(]/)[0]).slice(0, 30) || "Skript" };
  }
  return { type: "visit", name: shortUa(ua) };
}

// ------------------------------------------------- GeoIP (Land je IP)
// Lookup via ip-api.com (Batch, kostenlos), dauerhaft gecacht in
// data/geoip-cache.json – jede IP wird also höchstens einmal abgefragt.
const GEO_CACHE_FILE = join(ROOT, "data", "geoip-cache.json");
const PRIVATE_IP_RE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fe80:|f[cd])/i;
let geoCache = null;
let geoSaveTimer = null;

async function loadGeoCache() {
  if (geoCache) return geoCache;
  try {
    geoCache = new Map(Object.entries(JSON.parse(await readFile(GEO_CACHE_FILE, "utf8"))));
  } catch { geoCache = new Map(); }
  return geoCache;
}

function scheduleGeoSave() {
  if (geoSaveTimer) return;
  geoSaveTimer = setTimeout(async () => {
    geoSaveTimer = null;
    try {
      await mkdir(join(ROOT, "data"), { recursive: true });
      await writeFile(GEO_CACHE_FILE, JSON.stringify(Object.fromEntries(geoCache)), "utf8");
    } catch { /* Cache-Verlust ist unkritisch */ }
  }, 2000);
}

// Löst eine Liste von IPs auf; fehlende werden gebündelt nachgeschlagen
// (max. 100 pro Aufruf – Rest kommt beim nächsten Refresh dran).
async function geoLookup(ips) {
  const cache = await loadGeoCache();
  const missing = [...new Set(ips)]
    .filter((ip) => ip && !cache.has(ip) && !PRIVATE_IP_RE.test(ip))
    .slice(0, 100);
  if (missing.length) {
    try {
      const r = await fetch("http://ip-api.com/batch?fields=status,countryCode,country,city,hosting,proxy,query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(missing),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        for (const e of await r.json()) {
          cache.set(e.query, e.status === "success"
            ? { cc: e.countryCode || "", country: e.country || "", city: e.city || "", dc: !!(e.hosting || e.proxy) }
            : { cc: "", country: "", city: "", dc: false });
        }
        scheduleGeoSave();
      }
    } catch { /* offline/Rate-Limit → nächster Versuch beim nächsten Aufruf */ }
  }
  return cache;
}

async function recordClick(entry) {
  await mkdir(join(ROOT, "data"), { recursive: true });
  await appendFile(CLICKS_FILE, JSON.stringify(entry) + "\n", "utf8");
}

async function readClicks() {
  try {
    const raw = await readFile(CLICKS_FILE, "utf8");
    return raw.trim().split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// Liest die letzten ~5 MB des Access-Logs (reicht für die jüngste Historie).
async function readAccessLogTail() {
  try {
    const st = await stat(ACCESS_LOG);
    const size = 5 * 1024 * 1024;
    const start = Math.max(0, st.size - size);
    const fh = await open(ACCESS_LOG, "r");
    try {
      const buf = Buffer.alloc(st.size - start);
      await fh.read(buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      // erste (evtl. angeschnittene) Zeile verwerfen
      return text.slice(text.indexOf("\n") + 1).split("\n").filter(Boolean);
    } finally { await fh.close(); }
  } catch { return []; }
}

async function buildStats(days = 14) {
  const cutoff = Date.now() - days * 86400_000;

  // --- Klicks ---
  const clicks = (await readClicks()).filter((c) => new Date(c.ts).getTime() >= cutoff);
  const clicksByDay = {};
  const clicksByProduct = {};
  for (const c of clicks) {
    const day = c.ts.slice(0, 10);
    clicksByDay[day] = (clicksByDay[day] || 0) + 1;
    const key = `${c.c || "?"} / ${c.p || "?"}`;
    clicksByProduct[key] = (clicksByProduct[key] || 0) + 1;
  }

  // --- Access-Log: LLM-Crawler + echte Besucher ---
  const botHits = {};   // bot → count
  const botByDay = {};  // day → count
  const botPaths = {};  // path → count
  let lastBotHit = null;

  const visitorIps = new Map(); // ip → { hits, ua }
  const visitPaths = {};        // path → count (nur echte Besucher)
  const visitRefs = {};         // referrer-host → count
  const visitsByDay = {};       // day → count

  for (const line of await readAccessLogTail()) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const tsMs = e.ts * 1000;
    if (tsMs < cutoff) continue;
    const uri = e.request?.uri || "";
    if (STATIC_RE.test(uri) || uri.startsWith("/admin")) continue;
    const ua = e.request?.headers?.["User-Agent"]?.[0] || "";
    const day = new Date(tsMs).toISOString().slice(0, 10);
    const cls = classifyUa(ua);

    if (cls.type === "bot") {
      const llm = LLM_BOTS.find(([, re]) => re.test(ua));
      if (!llm) continue; // generische Bots nicht in der LLM-Tabelle zählen
      botHits[llm[0]] = (botHits[llm[0]] || 0) + 1;
      botByDay[day] = (botByDay[day] || 0) + 1;
      botPaths[uri] = (botPaths[uri] || 0) + 1;
      if (!lastBotHit || tsMs > lastBotHit.tsMs)
        lastBotHit = { tsMs, bot: llm[0], uri };
      continue;
    }

    // Echte Besucher
    const ip = e.request?.client_ip || e.request?.remote_ip || "";
    const v = visitorIps.get(ip) || { hits: 0, ua: cls.name };
    v.hits++;
    visitorIps.set(ip, v);
    visitsByDay[day] = (visitsByDay[day] || 0) + 1;
    visitPaths[uri] = (visitPaths[uri] || 0) + 1;
    const ref = e.request?.headers?.["Referer"]?.[0] || "";
    if (ref && !ref.includes("bookandbuy.de")) {
      try { visitRefs[new URL(ref).hostname] = (visitRefs[new URL(ref).hostname] || 0) + 1; }
      catch { /* kaputter Referer */ }
    }
  }

  // Länder der Besucher-IPs; Rechenzentrums-IPs (Hosting/Proxy) getrennt zählen
  const geo = await geoLookup([...visitorIps.keys()]);
  const byCountry = {}; // "DE Deutschland" → unique IPs
  let dcIps = 0;
  for (const ip of visitorIps.keys()) {
    const g = geo.get(ip);
    if (g?.dc) { dcIps++; continue; }
    const key = g?.country ? `${g.cc} ${g.country}` : "unbekannt";
    byCountry[key] = (byCountry[key] || 0) + 1;
  }

  const top = (obj, n) =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

  return {
    days,
    clicks: {
      total: clicks.length,
      byDay: clicksByDay,
      topProducts: top(clicksByProduct, 10),
    },
    visitors: {
      total: Object.values(visitsByDay).reduce((a, b) => a + b, 0),
      uniqueIps: visitorIps.size,
      dcIps, // davon Rechenzentrum/Proxy (vermutlich getarnte Bots)
      byDay: visitsByDay,
      byCountry: top(byCountry, 12),
      topPaths: top(visitPaths, 10),
      topReferrers: top(visitRefs, 10),
    },
    bots: {
      total: Object.values(botHits).reduce((a, b) => a + b, 0),
      byBot: top(botHits, 15),
      byDay: botByDay,
      topPaths: top(botPaths, 10),
      last: lastBotHit
        ? { at: new Date(lastBotHit.tsMs).toISOString(), bot: lastBotHit.bot, uri: lastBotHit.uri }
        : null,
    },
  };
}

// Live-Feed: die letzten Ereignisse (Seitenaufrufe aus dem Caddy-Log +
// Amazon-Klicks aus clicks.jsonl), gemischt und absteigend sortiert.
const STATIC_RE = /\.(css|js|png|jpg|jpeg|svg|ico|woff2?|webp|map|txt|xml)(\?|$)/i;

async function buildLiveFeed(limit = 60) {
  const events = [];

  // --- Seitenaufrufe (alle Besucher, Bots markiert) ---
  for (const line of await readAccessLogTail()) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const uri = e.request?.uri || "";
    if (STATIC_RE.test(uri)) continue;
    if (uri.startsWith("/admin")) continue; // eigenes Admin-Gewusel ausblenden
    const ua = e.request?.headers?.["User-Agent"]?.[0] || "";
    const cls = classifyUa(ua);
    events.push({
      ts: new Date(e.ts * 1000).toISOString(),
      type: cls.type,
      who: cls.name,
      what: uri,
      status: e.status,
      ref: e.request?.headers?.["Referer"]?.[0] || "",
      ip: e.request?.client_ip || e.request?.remote_ip || "",
    });
  }

  // --- Amazon-Klicks ---
  for (const c of await readClicks()) {
    events.push({
      ts: c.ts,
      type: "click",
      who: shortUa(c.ua || ""),
      what: `${c.c || "?"} → ${c.p || "?"}`,
      ref: c.path || "",
      ip: c.ip || "",
    });
  }

  events.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const slice = events.slice(0, limit);

  // Länder für die sichtbaren Events anreichern
  const geo = await geoLookup(slice.map((e) => e.ip));
  for (const e of slice) {
    const g = e.ip ? geo.get(e.ip) : null;
    if (g) { e.cc = g.cc; e.geo = [g.city, g.country].filter(Boolean).join(", "); e.dc = g.dc; }
  }

  return { generatedAt: new Date().toISOString(), events: slice };
}

// Kompakte Browser/OS-Kennung aus dem User-Agent.
function shortUa(ua) {
  if (!ua) return "unbekannt";
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /OPR\//.test(ua) ? "Opera" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Safari\//.test(ua) && /Version\//.test(ua) ? "Safari" :
    /Firefox\//.test(ua) ? "Firefox" :
    /curl|wget|python|go-http|node/i.test(ua) ? "Skript" : "Browser";
  const os =
    /iPhone|iPad/.test(ua) ? "iOS" :
    /Android/.test(ua) ? "Android" :
    /Mac OS X/.test(ua) ? "macOS" :
    /Windows/.test(ua) ? "Windows" :
    /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
}

// ---------------------------------------------------------------- Helpers
const json = (res, code, data) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};

const MAX_BODY = 256 * 1024; // 256 KB reichen für jeden legitimen Request

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > MAX_BODY) {
        req.destroy();
        reject(new Error("Body zu groß"));
      }
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
  });

// Einfaches Rate-Limit für den öffentlichen /t-Beacon (Schutz vor Flooding).
const beaconWindow = new Map(); // ip → { count, resetAt }
function beaconAllowed(ip) {
  const now = Date.now();
  const e = beaconWindow.get(ip);
  if (!e || now > e.resetAt) {
    beaconWindow.set(ip, { count: 1, resetAt: now + 60_000 });
    if (beaconWindow.size > 10_000) beaconWindow.clear(); // Speicher begrenzen
    return true;
  }
  return ++e.count <= 30; // max. 30 Beacons/Minute pro IP
}

// Slugs kommen aus URL-Pfaden → strikt validieren (kein Path-Traversal).
const SLUG_RE = /^[a-z0-9-]+$/;
const safeSlug = (s) => {
  if (!SLUG_RE.test(s || "")) throw new Error("ungültiger Slug");
  return s;
};

// ---------------------------------------------------------------- Server
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // --- UI (statische Admin-Seiten, Whitelist) ---
    if (req.method === "GET" && ADMIN_PAGES[path]) {
      const [file, type] = ADMIN_PAGES[path];
      const body = await readFile(join(ROOT, "server", file), "utf8");
      res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
      return res.end(body);
    }

    // --- Klick-Beacon (öffentlich; Caddy proxied /t hierher, ohne Auth) ---
    if (req.method === "POST" && (path === "/t" || path === "/track")) {
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
        || req.socket.remoteAddress || "?";
      if (!beaconAllowed(ip)) { res.writeHead(429); return res.end(); }
      let body = {};
      try { body = await readBody(req); } catch { /* leeres Beacon ok */ }
      await recordClick({
        ts: new Date().toISOString(),
        ip,
        k: String(body.k || "").slice(0, 40),
        p: String(body.p || "").slice(0, 80),
        c: String(body.c || "").slice(0, 80),
        path: String(body.path || "").slice(0, 200),
        ref: String(body.ref || "").slice(0, 200),
        ua: String(req.headers["user-agent"] || "").slice(0, 200),
      });
      res.writeHead(204);
      return res.end();
    }

    // --- Statistiken (Klicks + LLM-Crawler) ---
    if (req.method === "GET" && path === "/api/stats") {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 14));
      return json(res, 200, await buildStats(days));
    }

    // --- Live-Feed (letzte Ereignisse: Besuche, Bots, Klicks) ---
    if (req.method === "GET" && path === "/api/live") {
      const limit = Math.min(200, Math.max(10, Number(url.searchParams.get("limit")) || 60));
      return json(res, 200, await buildLiveFeed(limit));
    }

    // --- Status ---
    if (req.method === "GET" && path === "/api/status") {
      const suggestions = await loadSuggestions();
      const drafts = await listDrafts();
      return json(res, 200, {
        llmConfigured: llmConfigured(),
        discovery: state.discovery,
        generating: [...state.generating],
        publish: state.publish,
        autoDrafting: state.autoDrafting,
        bulkDraft: state.bulkDraft,
        suggestionsUpdatedAt: suggestions.updatedAt,
        suggestionCount: suggestions.items.filter((i) => !i.covered && !i.dismissed).length,
        draftCount: drafts.length,
      });
    }

    // --- Publish (Astro-Build; Caddy liefert dist/ direkt aus) ---
    if (req.method === "POST" && path === "/api/publish") {
      runPublish(); // Hintergrund
      return json(res, 202, { started: true });
    }

    // --- Discovery ---
    if (req.method === "POST" && path === "/api/discovery/run") {
      startDiscovery(); // bewusst nicht awaiten (läuft im Hintergrund)
      return json(res, 202, { started: true });
    }
    if (req.method === "GET" && path === "/api/suggestions") {
      const data = await loadSuggestions();
      const drafts = await listDrafts();
      const live = await loadLiveCategories();
      // Live-/Entwurf-Zuordnung für die UI – dynamisch statt des veralteten
      // covered-Flags aus dem Discovery-Lauf (verhindert doppelte Einträge).
      data.items = data.items.map((i) => {
        const l = findLiveForTerm(i.term, live);
        const d = findDraftForTerm(i.term, drafts);
        return { ...i, liveSlug: l ? l.slug : null, draftSlug: d ? d.slug : null };
      });
      return json(res, 200, data);
    }
    if (req.method === "POST" && path === "/api/suggestions/dismiss") {
      const { term } = await readBody(req);
      const data = await loadSuggestions();
      const item = data.items.find((i) => i.term === term);
      if (item) item.dismissed = true;
      await saveSuggestions(data);
      return json(res, 200, { ok: true });
    }

    // --- Generierung ---
    if (req.method === "POST" && path === "/api/generate/all") {
      if (state.bulkDraft.running)
        return json(res, 409, { error: "Bulk-Generierung läuft bereits" });
      runBulkDrafts(); // Hintergrund; Fortschritt via /api/status
      return json(res, 202, { started: true });
    }
    if (req.method === "POST" && path === "/api/generate") {
      const { term } = await readBody(req);
      if (!term) return json(res, 400, { error: "term fehlt" });
      if (state.generating.has(term))
        return json(res, 409, { error: "läuft bereits" });
      // Duplikat-Schutz: nie einen zweiten Entwurf zu etwas erzeugen,
      // das schon live ist oder bereits als Entwurf wartet.
      const liveHit = findLiveForTerm(term, await loadLiveCategories());
      if (liveHit)
        return json(res, 409, {
          error: `„${term}“ ist bereits live als /${liveHit.slug}/ – dort „Neu einlesen“ nutzen statt neu anzulegen.`,
        });
      const draftHit = findDraftForTerm(term, await listDrafts());
      if (draftHit)
        return json(res, 409, {
          error: `Zu „${term}“ wartet schon der Entwurf „${draftHit.slug}“ auf Review.`,
        });
      state.generating.add(term);
      try {
        await markDrafted(term); // 24h-Drossel-Log (manuell zählt auch)
        const draft = await generateDraft(term);
        return json(res, 200, { ok: true, slug: draft.slug });
      } finally {
        state.generating.delete(term);
      }
    }

    // --- Entwürfe ---
    if (req.method === "GET" && path === "/api/drafts") {
      return json(res, 200, await listDrafts());
    }
    if (req.method === "GET" && path.startsWith("/api/drafts/")) {
      const slug = safeSlug(path.split("/")[3]);
      return json(res, 200, await getDraft(slug));
    }
    if (req.method === "PUT" && path.startsWith("/api/drafts/")) {
      const slug = safeSlug(path.split("/")[3]);
      const body = await readBody(req);
      await saveDraft(slug, body);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path.startsWith("/api/drafts/") && path.endsWith("/approve")) {
      const slug = safeSlug(path.split("/")[3]);
      // Duplikat-Schutz: Entwurf würde eine zweite Live-Seite neben einer
      // bestehenden erzeugen (anderer Slug, aber gleiches Thema).
      // Gleicher Slug = bewusstes Ersetzen (Regenerieren) → erlaubt.
      const liveDup = findLiveForTerm(slug, await loadLiveCategories());
      if (liveDup && liveDup.slug !== slug) {
        const { force } = await readBody(req).catch(() => ({}));
        if (!force)
          return json(res, 409, {
            error: `Würde ein Duplikat zu /${liveDup.slug}/ erzeugen. Entwurf verwerfen – oder Freigabe wiederholen, um es trotzdem zu tun.`,
            duplicateOf: liveDup.slug,
          });
      }
      // Nur NEUE Kategorien auf Bluesky ankündigen (Regenerierung = still)
      const isNew = !(await stat(join(CATEGORIES_DIR, `${slug}.json`)).catch(() => null));
      await approveDraft(slug);
      runPublish(isNew ? slug : undefined); // Freigabe stößt automatisch den Live-Build an
      return json(res, 200, { ok: true, publishing: true });
    }
    if (req.method === "POST" && path.startsWith("/api/drafts/") && path.endsWith("/reject")) {
      const slug = safeSlug(path.split("/")[3]);
      await rejectDraft(slug);
      return json(res, 200, { ok: true });
    }

    // --- Live-Kategorie neu generieren (Amazon-first) → landet als Entwurf ---
    if (req.method === "POST" && /^\/api\/categories\/[^/]+\/regenerate$/.test(path)) {
      const slug = safeSlug(path.split("/")[3]);
      const file = join(CATEGORIES_DIR, `${slug}.json`);
      const existing = JSON.parse(await readFile(file, "utf8"));
      const term = existing.searchTerms?.[0] || existing.name || slug;
      if (state.generating.has(term))
        return json(res, 409, { error: "läuft bereits" });
      state.generating.add(term);
      try {
        const draft = await generateDraft(term, { slug }); // Slug bleibt → URL stabil
        return json(res, 200, { ok: true, slug: draft.slug, term });
      } finally {
        state.generating.delete(term);
      }
    }

    // --- Live-Kategorien auflisten (?full=1 → inkl. Produktliste) ---
    if (req.method === "GET" && path === "/api/categories") {
      const full = url.searchParams.get("full") === "1";
      const files = (await readdir(CATEGORIES_DIR).catch(() => []))
        .filter((f) => f.endsWith(".json"));
      const cats = [];
      for (const f of files) {
        const d = JSON.parse(await readFile(join(CATEGORIES_DIR, f), "utf8"));
        const cat = {
          slug: d.slug, name: d.name, updatedAt: d.updatedAt,
          products: d.products.length,
          missingAsin: d.products.filter((p) => !p.asin).length,
        };
        if (full) {
          cat.items = d.products.map((p) => ({
            name: p.name, brand: p.brand || "", asin: p.asin || "",
            image: p.image || "", price: p.price || null,
            asinStatus: p.asinStatus || "", asinCheckedAt: p.asinCheckedAt || "",
          }));
        }
        cats.push(cat);
      }
      return json(res, 200, cats);
    }

    // --- Einstellungen (Recheck-Intervall) ---
    if (req.method === "GET" && path === "/api/settings") {
      const s = await loadSettings();
      return json(res, 200, { ...s, recheck: state.recheck });
    }
    if (req.method === "PUT" && path === "/api/settings") {
      const body = await readBody(req);
      const hours = Math.max(0, Math.min(720, Number(body.recheckHours)));
      if (!Number.isFinite(hours)) return json(res, 400, { error: "recheckHours ungültig" });
      const s = await loadSettings();
      s.recheckHours = hours;
      await saveSettings(s);
      await scheduleRecheck(); // Timer sofort mit neuem Intervall neu setzen
      return json(res, 200, { ...s, recheck: state.recheck });
    }

    // --- Recheck sofort ausführen ---
    if (req.method === "POST" && path === "/api/recheck/run") {
      if (state.recheck.running) return json(res, 409, { error: "läuft bereits" });
      runRecheck(); // Hintergrund
      return json(res, 202, { started: true });
    }

    // --- ASIN-Verifikation (Entwurf oder Live-Kategorie) ---
    if (req.method === "POST" && /^\/api\/(drafts|categories)\/[^/]+\/verify$/.test(path)) {
      const [, , kind, rawSlug] = path.split("/");
      const slug = safeSlug(rawSlug);
      const dir = kind === "drafts" ? "drafts" : "categories";
      const file = join(ROOT, "data", dir, `${slug}.json`);
      const data = JSON.parse(await readFile(file, "utf8"));
      const report = await verifyProducts(data.products);
      data.asinReport = report;
      await writeFile(file, JSON.stringify(data, null, 2), "utf8");
      if (kind === "categories") runPublish(); // Live-Daten geändert → neu bauen
      return json(res, 200, { ok: true, report });
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});
server.listen(PORT, HOST, () => {
  console.log(`BookAndBuy-Admin läuft: http://${HOST}:${PORT}`);
  console.log(`Azure OpenAI: ${llmConfigured() ? "konfiguriert ✅" : "NICHT konfiguriert – Key in .env setzen"}`);
  if (process.env.AUTO_PILOT !== "0") {
    scheduleAutoPilot();
    scheduleRecheck();
  }
});
