#!/usr/bin/env node
// Zitier-Monitor: prüft, ob kauffakten.de in KI-Suchergebnissen auftaucht.
//
// Stufe 1 (kostenlos, sofort): prüft die Bing-Indexierung der eigenen URLs –
//   ohne Bing-Index keine ChatGPT-Zitate. Nutzt die normale Bing-Suche.
// Stufe 2 (optional, API-Key nötig): stellt die Ziel-Fragen an Perplexity
//   (PERPLEXITY_API_KEY) und prüft die zitierten Quellen auf kauffakten.de.
//
// Nutzung:  node scripts/citation-monitor.mjs
//           PERPLEXITY_API_KEY=... node scripts/citation-monitor.mjs

import { readFile, readdir } from "node:fs/promises";

const DOMAIN = "kauffakten.de";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadQuestions() {
  const dir = "data/categories";
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const questions = [];
  for (const f of files) {
    const cat = JSON.parse(await readFile(`${dir}/${f}`, "utf8"));
    for (const faq of cat.faqs) questions.push(faq.q);
    for (const term of cat.searchTerms) questions.push(term);
  }
  return questions;
}

// Stufe 1: Ist die Domain im Bing-Index?
async function checkBingIndex() {
  const res = await fetch(
    `https://www.bing.com/search?q=${encodeURIComponent(`site:${DOMAIN}`)}`,
    { headers: { "User-Agent": UA, "Accept-Language": "de-DE" } }
  );
  const html = await res.text();
  const indexed = html.includes(DOMAIN) && !html.includes("keine Ergebnisse");
  console.log(
    `Bing-Index (site:${DOMAIN}): ${indexed ? "✅ Treffer gefunden" : "❌ noch nicht indexiert"}`
  );
  return indexed;
}

// Stufe 2: Perplexity-API befragen und Quellen prüfen.
async function checkPerplexity(questions) {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) {
    console.log(
      "\nPERPLEXITY_API_KEY nicht gesetzt – Stufe 2 (Zitier-Check) übersprungen."
    );
    return;
  }
  console.log(`\nZitier-Check: ${questions.length} Fragen gegen Perplexity …\n`);
  let cited = 0;
  for (const q of questions) {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: q }],
      }),
    });
    if (!res.ok) {
      console.error(`  API-Fehler ${res.status} bei: ${q}`);
      continue;
    }
    const data = await res.json();
    const sources = data.citations || [];
    const hit = sources.some((s) => s.includes(DOMAIN));
    if (hit) cited++;
    console.log(`${hit ? "✅ ZITIERT" : "—"}  ${q}`);
    await sleep(1000);
  }
  console.log(`\nErgebnis: ${cited}/${questions.length} Fragen zitieren ${DOMAIN}`);
}

async function main() {
  console.log(`Zitier-Monitor ${new Date().toISOString().slice(0, 16)}\n`);
  const questions = await loadQuestions();
  console.log(`${questions.length} Ziel-Fragen geladen.\n`);
  await checkBingIndex();
  await checkPerplexity(questions);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
