// Automatische Kategorie-Discovery: Google Suggest Harvest + Filterung.
// Liefert Vorschläge, welche Produktkategorien neu aufgenommen werden sollten.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./env.mjs";

const SUGGEST_URL = (q) =>
  `https://suggestqueries.google.com/complete/search?client=firefox&hl=de&q=${encodeURIComponent(q)}`;

const HARVEST_PREFIXES = [
  "bester", "beste", "lohnt sich ein", "lohnt sich eine",
  "welcher", "welche", "test",
];
const ALPHABET = "abcdefghijklmnopqrstuvwxyz".split("");

// Nicht-Produkt-Rauschen (Lokales, Dienstleistungen, Essen, Berufe ...)
const NOISE =
  /\b(wien|berlin|münchen|hamburg|graz|linz|salzburg|in der nähe|arzt|zahnarzt|friseur|barber|anwalt|restaurant|döner|pizza(?!ofen)|burger|sushi|chinese|italiener|inder|japaner|asiate|brunch|café|cafe|club|bar|hotel|campingplatz|versicherung|broker|etf|aktie|kredit|job|beruf|studium|schule|englisch|deutsch|rezept|kuchen|torte|strudel|biskuit|cheesecake|tag ist|passt zu mir|youtuber|youngtimer|film|serie|buch|spiel des jahres|urlaubsziel|reiseziel|ausflugsziel|dinopark|zoo|museum|wanderweg|see|strand)\b/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSuggestions(query) {
  try {
    const res = await fetch(SUGGEST_URL(query), {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh) bookandbuy-discovery/1.0" },
    });
    const parsed = JSON.parse(await res.text());
    return Array.isArray(parsed?.[1]) ? parsed[1] : [];
  } catch {
    return [];
  }
}

async function existingCategories() {
  const dir = join(ROOT, "data", "categories");
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    const cats = [];
    for (const f of files) {
      const c = JSON.parse(await readFile(join(dir, f), "utf8"));
      cats.push({ slug: c.slug, name: c.name, terms: c.searchTerms ?? [] });
    }
    return cats;
  } catch {
    return [];
  }
}

function isCovered(product, cats) {
  const p = product.toLowerCase();
  return cats.some(
    (c) =>
      p.includes(c.slug) ||
      c.name.toLowerCase().includes(p) ||
      p.includes(c.name.toLowerCase().split(" ")[0]) ||
      c.terms.some((t) => t.toLowerCase().includes(p) || p.includes(t.toLowerCase()))
  );
}

/**
 * Vollständiger Discovery-Lauf.
 * @param {(msg:string)=>void} onProgress optionaler Fortschritts-Callback
 * @returns {Promise<Array<{term:string,hits:number,covered:boolean}>>}
 */
export async function runDiscovery(onProgress = () => {}) {
  const counts = new Map();
  const total = HARVEST_PREFIXES.length * ALPHABET.length;
  let done = 0;

  for (const prefix of HARVEST_PREFIXES) {
    for (const letter of ALPHABET) {
      const suggestions = await getSuggestions(`${prefix} ${letter}`);
      for (const s of suggestions) {
        const product = s.replace(new RegExp(`^${prefix}\\s+`, "i"), "").trim();
        if (product.length < 3) continue;
        if (NOISE.test(product)) continue;
        counts.set(product, (counts.get(product) ?? 0) + 1);
      }
      done++;
      if (done % 26 === 0) onProgress(`Harvest ${done}/${total} Abfragen …`);
      await sleep(120);
    }
  }

  const cats = await existingCategories();
  return [...counts.entries()]
    .filter(([, n]) => n >= 2) // mind. 2 Präfix-Treffer = echte Nachfrage
    .sort((a, b) => b[1] - a[1])
    .map(([term, hits]) => ({ term, hits, covered: isCovered(term, cats) }));
}
