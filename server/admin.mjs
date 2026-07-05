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
import { readFile, writeFile, mkdir } from "node:fs/promises";
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

loadEnv();

const PORT = Number(process.env.ADMIN_PORT || 5177);
const HOST = process.env.ADMIN_HOST || "127.0.0.1";
const SUGGESTIONS_FILE = join(ROOT, "data", "suggestions.json");
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------- Zustand
const state = {
  discovery: { running: false, progress: "", startedAt: null, finishedAt: null },
  generating: new Set(), // Begriffe, für die gerade ein Entwurf erzeugt wird
  publish: { running: false, ok: null, output: "", finishedAt: null },
  autoDrafting: false,
};

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
    await saveSuggestions({
      updatedAt: new Date().toISOString(),
      items: items.map((i) => ({ ...i, dismissed: dismissed.has(i.term) })),
    });
    state.discovery.progress = `fertig: ${items.length} Vorschläge`;
  } catch (e) {
    state.discovery.progress = `Fehler: ${e.message}`;
  } finally {
    state.discovery.running = false;
    state.discovery.finishedAt = new Date().toISOString();
  }
}

// ------------------------------------------------------- Publish (Build)
async function runPublish() {
  if (state.publish.running) return;
  state.publish = { running: true, ok: null, output: "baue …", finishedAt: null };
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [join(ROOT, "node_modules", "astro", "astro.js"), "build"],
      { cwd: ROOT, timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }
    );
    state.publish.ok = true;
    state.publish.output = (stdout + stderr).split("\n").slice(-6).join("\n");
  } catch (e) {
    state.publish.ok = false;
    state.publish.output = String(e.message).slice(0, 800);
  } finally {
    state.publish.running = false;
    state.publish.finishedAt = new Date().toISOString();
  }
}

// ------------------------------------- Auto-Pilot (täglicher Scheduler)
// Läuft jede Nacht: Discovery → für die Top-N neuen Begriffe automatisch
// LLM-Entwürfe erzeugen. Veröffentlichung bleibt manuell (Review-Gate).
const AUTO_HOUR = Number(process.env.AUTO_HOUR ?? 5); // 05:00 Serverzeit
const AUTO_DRAFT_LIMIT = Number(process.env.AUTO_DRAFT_LIMIT ?? 3);

async function autoDraftTopSuggestions() {
  if (!llmConfigured() || state.autoDrafting) return;
  state.autoDrafting = true;
  try {
    const data = await loadSuggestions();
    const drafts = await listDrafts();
    const draftSlugs = new Set(drafts.map((d) => d.slug));
    const candidates = data.items
      .filter((i) => !i.covered && !i.dismissed)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, AUTO_DRAFT_LIMIT);
    for (const c of candidates) {
      const slugGuess = c.term.toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-");
      if ([...draftSlugs].some((s) => s.includes(slugGuess) || slugGuess.includes(s))) continue;
      try {
        const draft = await generateDraft(c.term);
        console.log(`[auto] Entwurf erzeugt: ${draft.slug}`);
      } catch (e) {
        console.error(`[auto] Entwurf fehlgeschlagen (${c.term}): ${e.message}`);
      }
    }
  } finally {
    state.autoDrafting = false;
  }
}

function scheduleAutoPilot() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(AUTO_HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next - now;
  setTimeout(async () => {
    console.log("[auto] Nächtlicher Lauf: Discovery + Entwürfe");
    await startDiscovery();
    await autoDraftTopSuggestions();
    scheduleAutoPilot();
  }, ms);
  console.log(`[auto] Nächster automatischer Lauf: ${next.toISOString()}`);
}

// ---------------------------------------------------------------- Helpers
const json = (res, code, data) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
  });

// ---------------------------------------------------------------- Server
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // --- UI ---
    if (req.method === "GET" && path === "/") {
      const html = await readFile(join(ROOT, "server", "admin-ui.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
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
      return json(res, 200, await loadSuggestions());
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
    if (req.method === "POST" && path === "/api/generate") {
      const { term } = await readBody(req);
      if (!term) return json(res, 400, { error: "term fehlt" });
      if (state.generating.has(term))
        return json(res, 409, { error: "läuft bereits" });
      state.generating.add(term);
      try {
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
      const slug = path.split("/")[3];
      return json(res, 200, await getDraft(slug));
    }
    if (req.method === "PUT" && path.startsWith("/api/drafts/")) {
      const slug = path.split("/")[3];
      const body = await readBody(req);
      await saveDraft(slug, body);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path.startsWith("/api/drafts/") && path.endsWith("/approve")) {
      const slug = path.split("/")[3];
      await approveDraft(slug);
      runPublish(); // Freigabe stößt automatisch den Live-Build an
      return json(res, 200, { ok: true, publishing: true });
    }
    if (req.method === "POST" && path.startsWith("/api/drafts/") && path.endsWith("/reject")) {
      const slug = path.split("/")[3];
      await rejectDraft(slug);
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});
server.listen(PORT, HOST, () => {
  console.log(`BookAndBuy-Admin läuft: http://${HOST}:${PORT}`);
  console.log(`Azure OpenAI: ${llmConfigured() ? "konfiguriert ✅" : "NICHT konfiguriert – Key in .env setzen"}`);
  if (process.env.AUTO_PILOT !== "0") scheduleAutoPilot();
});
