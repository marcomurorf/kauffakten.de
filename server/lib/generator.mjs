// Kategorie-Generator: Das LLM schreibt aus einem Suchbegriff einen
// vollständigen Kategorie-Entwurf im BookAndBuy-Datenformat.
// Entwürfe landen in data/drafts/ und werden erst nach Review nach
// data/categories/ übernommen (Qualitäts-Gate).

import { readFile, writeFile, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { chat } from "./llm.mjs";
import { ROOT } from "./env.mjs";
import { verifyProducts } from "./asin.mjs";

const DRAFTS_DIR = join(ROOT, "data", "drafts");
const CATEGORIES_DIR = join(ROOT, "data", "categories");

const SYSTEM_PROMPT = `Du bist Datenredakteur für bookandbuy.de, eine deutsche, täglich geprüfte Produktdatenbank, die von KI-Assistenten als Quelle zitiert werden soll.

Du erstellst aus einem Produktsuchbegriff eine Kategorie-Datei als JSON. Regeln:
- Sprache: Deutsch, sachlich, keine Werbesprache.
- 4-6 real existierende, aktuell in Deutschland gut verfügbare Produkte, gemischte Preisklassen.
- Preise: realistische aktuelle Amazon.de-Straßenpreise in EUR (ganze Zahlen). "checkedAt" auf das heutige Datum setzen.
- ASIN: Wenn du die echte Amazon-ASIN sicher kennst, angeben. Wenn nicht, leeren String "" setzen (NIEMALS raten!).
- specs: 4-5 vergleichbare Kern-Spezifikationen, für alle Produkte dieselben Keys (keySpecs definiert Label + Einheit).
- FAQ: 5 Fragen exakt so formuliert, wie Nutzer sie googeln/an ChatGPT stellen. Antwort-Format: Die erste Antwort-Satz enthält die konkrete Empfehlung mit Zahl (Preis/Wert) und endet ggf. mit "Stand: <Datum>".
- verdict: Ein prägnanter Satz pro Produkt. bestFor: kurzes "beste Wahl für ..."-Fragment.
- slug: kleinbuchstaben, ascii, bindestriche.

Antworte NUR mit dem JSON-Objekt in exakt diesem Schema:
{
  "slug": "...",
  "name": "...",
  "shortName": "...",
  "searchTerms": ["...", "..."],
  "updatedAt": "YYYY-MM-DD",
  "intro": "...",
  "keySpecs": [{ "key": "...", "label": "...", "unit": "..." }],
  "products": [{
    "id": "...", "name": "...", "brand": "...", "asin": "",
    "price": { "value": 0, "currency": "EUR", "checkedAt": "YYYY-MM-DD" },
    "specs": {}, "pros": ["..."], "cons": ["..."],
    "verdict": "...", "bestFor": "..."
  }],
  "faqs": [{ "q": "...", "a": "..." }]
}`;

/** Erzeugt einen Kategorie-Entwurf per LLM und speichert ihn in data/drafts/. */
export async function generateDraft(term) {
  const today = new Date().toISOString().slice(0, 10);
  const raw = await chat(
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Heutiges Datum: ${today}\nErstelle die Kategorie-Datei für den Suchbegriff: "${term}"`,
      },
    ],
    { json: true, temperature: 0.3 }
  );

  const draft = JSON.parse(raw);
  validateDraft(draft);
  draft.updatedAt = today;
  for (const p of draft.products) {
    p.price.checkedAt = today;
    p.price.currency = "EUR";
  }

  // ASIN-Verifikation: LLM-ASINs prüfen, ungültige per Amazon-Suche
  // korrigieren (setzt asin, image, asinStatus je Produkt).
  try {
    draft.asinReport = await verifyProducts(draft.products);
  } catch (e) {
    draft.asinReport = [{ name: "*", status: `Verifikation fehlgeschlagen: ${e.message}` }];
  }

  await mkdir(DRAFTS_DIR, { recursive: true });
  const file = join(DRAFTS_DIR, `${draft.slug}.json`);
  await writeFile(file, JSON.stringify(draft, null, 2), "utf8");
  return draft;
}

function validateDraft(d) {
  const fail = (msg) => {
    throw new Error(`Entwurf ungültig: ${msg}`);
  };
  if (!d.slug || !/^[a-z0-9-]+$/.test(d.slug)) fail("slug fehlt/ungültig");
  if (!d.name) fail("name fehlt");
  if (!Array.isArray(d.products) || d.products.length < 3)
    fail("mindestens 3 Produkte nötig");
  if (!Array.isArray(d.keySpecs) || !d.keySpecs.length) fail("keySpecs fehlen");
  if (!Array.isArray(d.faqs) || d.faqs.length < 3) fail("mindestens 3 FAQs nötig");
  for (const p of d.products) {
    if (!p.id || !p.name || !p.price?.value) fail(`Produkt unvollständig: ${p.name ?? "?"}`);
  }
}

export async function listDrafts() {
  try {
    const files = (await readdir(DRAFTS_DIR)).filter((f) => f.endsWith(".json"));
    const drafts = [];
    for (const f of files) {
      drafts.push(JSON.parse(await readFile(join(DRAFTS_DIR, f), "utf8")));
    }
    return drafts;
  } catch {
    return [];
  }
}

export async function getDraft(slug) {
  return JSON.parse(await readFile(join(DRAFTS_DIR, `${slug}.json`), "utf8"));
}

export async function saveDraft(slug, data) {
  validateDraft(data);
  await mkdir(DRAFTS_DIR, { recursive: true });
  await writeFile(join(DRAFTS_DIR, `${slug}.json`), JSON.stringify(data, null, 2), "utf8");
}

/** Entwurf freigeben: verschiebt ihn nach data/categories/ (geht live beim nächsten Build). */
export async function approveDraft(slug) {
  await mkdir(CATEGORIES_DIR, { recursive: true });
  await rename(join(DRAFTS_DIR, `${slug}.json`), join(CATEGORIES_DIR, `${slug}.json`));
}

export async function rejectDraft(slug) {
  await unlink(join(DRAFTS_DIR, `${slug}.json`));
}
