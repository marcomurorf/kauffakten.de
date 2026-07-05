#!/usr/bin/env node
/**
 * Trend-Radar: Findet kommerzielle Produkt-Trends aus Google Trends (DE).
 *
 * Ablauf:
 *  1. Google Trends Daily-RSS (geo=DE) abrufen -> rohe Trendbegriffe + Traffic
 *  2. Pro Begriff Google Suggest abfragen und Kauf-Signale zaehlen
 *     ("test", "kaufen", "vergleich", "preis", ...)
 *  3. Nur Begriffe mit Kauf-Score ausgeben, sortiert nach Score + Traffic
 *
 * Nutzung:  node scripts/trend-radar.mjs [--min-score 1] [--all]
 *   --all       zeigt auch Begriffe ohne Kauf-Signal (Debug)
 *   --min-score minimale Anzahl Kauf-Signale (Default: 1)
 *
 * Modus 2 — Nachfrage-Harvesting (unabhaengig vom Tages-News-Rauschen):
 *   node scripts/trend-radar.mjs --harvest
 *   Fragt Google Suggest mit Kauf-Praefixen ("bester a..z", "lohnt sich ein a..z", ...)
 *   ab und sammelt alle Produkte, nach denen Deutschland gerade wirklich sucht.
 */

const GEO = "DE";
const RSS_URL = `https://trends.google.de/trending/rss?geo=${GEO}`;
const SUGGEST_URL = (q) =>
  `https://suggestqueries.google.com/complete/search?client=firefox&hl=de&q=${encodeURIComponent(q)}`;

// Woerter in Suggest-Vorschlaegen, die Kaufinteresse signalisieren
const BUY_SIGNALS = [
  "test", "kaufen", "vergleich", "preis", "erfahrung", "erfahrungen",
  "amazon", "bestellen", "kosten", "angebot", "testsieger", "bester",
  "beste", "günstig", "guenstig", "media markt", "mediamarkt", "saturn",
  "lidl", "aldi", "idealo", "review", "alternative",
];

// Begriffe, die fast immer News/Promi/Sport sind -> frueh aussortieren
const NOISE_PATTERNS =
  /\b(vs|gegen|live|ticker|tot|gestorben|wetter|wahl|krieg|nato|bundesliga|wm|em|olympia|tatort|unfall|polizei|news)\b/i;

const args = process.argv.slice(2);
const showAll = args.includes("--all");
const minScoreIdx = args.indexOf("--min-score");
const minScore = minScoreIdx >= 0 ? Number(args[minScoreIdx + 1]) : 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh) trend-radar/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} für ${url}`);
  return res.text();
}

function parseRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim();
    const traffic =
      block.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/)?.[1]?.trim() ?? "?";
    if (title) items.push({ term: title, traffic });
  }
  return items;
}

async function getSuggestions(query) {
  try {
    const body = await fetchText(SUGGEST_URL(query));
    const parsed = JSON.parse(body);
    return Array.isArray(parsed?.[1]) ? parsed[1] : [];
  } catch {
    return [];
  }
}

function scoreSuggestions(term, suggestions) {
  const hits = new Set();
  for (const s of suggestions) {
    const rest = s.toLowerCase().replace(term.toLowerCase(), "");
    for (const sig of BUY_SIGNALS) {
      if (rest.includes(sig)) hits.add(sig);
    }
  }
  return { score: hits.size, signals: [...hits] };
}

// --- Modus 2: Nachfrage-Harvesting ------------------------------------------
// Kauf-Praefixe, die Google mit konkreten Produkten vervollstaendigt.
const HARVEST_PREFIXES = [
  "bester", "beste", "lohnt sich ein", "lohnt sich eine",
  "welcher", "welche", "test",
];
const ALPHABET = "abcdefghijklmnopqrstuvwxyz".split("");

async function harvest() {
  console.log(`Nachfrage-Harvest ${new Date().toISOString().slice(0, 16)} (hl=de)\n`);
  const counts = new Map(); // vorschlag -> Anzahl Praefixe, unter denen er auftaucht

  for (const prefix of HARVEST_PREFIXES) {
    for (const letter of ALPHABET) {
      const suggestions = await getSuggestions(`${prefix} ${letter}`);
      for (const s of suggestions) {
        const product = s.replace(new RegExp(`^${prefix}\\s+`, "i"), "").trim();
        if (product.length < 3) continue;
        counts.set(product, (counts.get(product) ?? 0) + 1);
      }
      await sleep(150);
    }
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("HITS", 6) + "PRODUKT/FRAGE");
  console.log("-".repeat(80));
  for (const [product, n] of sorted.slice(0, 120)) {
    console.log(pad(n, 6) + product);
  }
  console.log(`\n${counts.size} eindeutige Vorschläge gesammelt (Top 120 angezeigt).`);
}

async function main() {
  if (args.includes("--harvest")) return harvest();
  console.log(`Trend-Radar ${new Date().toISOString().slice(0, 16)} (geo=${GEO})\n`);

  const xml = await fetchText(RSS_URL);
  const items = parseRss(xml);
  if (!items.length) {
    console.error("Keine Trends im RSS-Feed gefunden.");
    process.exit(1);
  }

  const results = [];
  for (const { term, traffic } of items) {
    if (NOISE_PATTERNS.test(term)) {
      if (showAll) results.push({ term, traffic, score: -1, signals: ["(Noise-Filter)"] });
      continue;
    }
    // Zwei Suggest-Abfragen: "<term> " (Modifier) und "<term> kaufen" (Kaufabsicht-Check)
    const [sugA, sugB] = [
      await getSuggestions(`${term} `),
      await getSuggestions(`${term} kaufen`),
    ];
    const { score, signals } = scoreSuggestions(term, sugA);
    const kaufenBonus = sugB.some((s) => s.toLowerCase().includes("kaufen")) ? 1 : 0;
    results.push({ term, traffic, score: score + kaufenBonus, signals });
    await sleep(300); // Rate-Limit schonen
  }

  const relevant = results
    .filter((r) => showAll || r.score >= minScore)
    .sort((a, b) => b.score - a.score);

  if (!relevant.length) {
    console.log(`Heute keine Trends mit Kauf-Score >= ${minScore}. (${items.length} Begriffe geprüft)`);
    return;
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("SCORE", 6) + pad("TRAFFIC", 9) + pad("BEGRIFF", 34) + "KAUF-SIGNALE");
  console.log("-".repeat(90));
  for (const r of relevant) {
    console.log(
      pad(r.score, 6) + pad(r.traffic, 9) + pad(r.term, 34) + r.signals.join(", ")
    );
  }
  console.log(`\n${items.length} Trendbegriffe geprüft, ${relevant.length} angezeigt.`);
}

main().catch((e) => {
  console.error("Fehler:", e.message);
  process.exit(1);
});
