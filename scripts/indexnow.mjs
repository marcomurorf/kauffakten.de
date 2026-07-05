#!/usr/bin/env node
// IndexNow-Ping: meldet alle Sitemap-URLs sofort an Bing (und damit an
// die ChatGPT-Suche, die auf dem Bing-Index sitzt).
//
// Voraussetzung: Ein API-Key als Textdatei unter public/<key>.txt,
// deren Inhalt exakt der Key ist. Key hier oder per Env INDEXNOW_KEY setzen.
//
// Nutzung:  node scripts/indexnow.mjs            (liest dist/sitemap-0.xml)
//           node scripts/indexnow.mjs URL1 URL2  (nur bestimmte URLs)

import { readFile } from "node:fs/promises";

const HOST = "www.bookandbuy.de";
const KEY = process.env.INDEXNOW_KEY || "REPLACE_WITH_INDEXNOW_KEY";

async function urlsFromSitemap() {
  const xml = await readFile("dist/sitemap-0.xml", "utf8");
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

async function main() {
  if (KEY.startsWith("REPLACE")) {
    console.error(
      "Kein IndexNow-Key gesetzt. INDEXNOW_KEY-Env setzen und public/<key>.txt anlegen."
    );
    process.exit(1);
  }

  const urls =
    process.argv.length > 2 ? process.argv.slice(2) : await urlsFromSitemap();

  const body = {
    host: HOST,
    key: KEY,
    keyLocation: `https://${HOST}/${KEY}.txt`,
    urlList: urls,
  };

  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });

  console.log(`IndexNow: ${urls.length} URLs gemeldet → HTTP ${res.status}`);
  if (!res.ok) console.error(await res.text());
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
