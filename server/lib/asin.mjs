// ASIN-Verifikation und -Suche.
//
// checkAsin(asin)   → prüft über den Amazon-Bilder-CDN, ob die ASIN existiert
//                     (ungültige ASINs liefern ein 43-Byte-1×1-GIF).
// findAsin(query)   → scraped die Amazon.de-Suche und liefert die beste ASIN
//                     samt Titel (für Auto-Korrektur falscher LLM-ASINs).
// verifyProducts()  → prüft/korrigiert alle Produkte eines Entwurfs.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

export function asinImageUrl(asin, size = "SL500") {
  return `https://images-eu.ssl-images-amazon.com/images/P/${asin}.03._${size}_.jpg`;
}

/** true = ASIN existiert (Produktbild vorhanden), false = ungültig. */
export async function checkAsin(asin) {
  if (!/^B0[A-Z0-9]{8}$/.test(asin || "")) return false;
  try {
    const res = await fetch(asinImageUrl(asin, "SL160"), {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const buf = await res.arrayBuffer();
    return buf.byteLength > 500; // 1×1-Platzhalter-GIF = 43 Bytes
  } catch {
    return false;
  }
}

/** Amazon.de-Suche → [{ asin, title }] der organischen Treffer.
 *  Bei 503 (Rate-Limit) bis zu 3 Versuche mit wachsendem Backoff. */
export async function searchAmazon(query) {
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(
      `https://www.amazon.de/s?k=${encodeURIComponent(query)}`,
      {
        headers: {
          "User-Agent": UA,
          "Accept-Language": "de-DE,de;q=0.9",
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (res.ok) break;
    if (res.status === 503 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 8_000 * (attempt + 1)));
      continue;
    }
    throw new Error(`Amazon-Suche: HTTP ${res.status}`);
  }
  const html = await res.text();

  // Titel steckt zuverlässig im alt-Text des Produktbilds, die echte
  // Bild-URL (m.media-amazon.com) im src desselben img-Tags.
  const results = [];
  const re = /data-asin="(B0[A-Z0-9]{8})"[\s\S]{0,3000}?<img[^>]*src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"[^>]*alt="([^"]{10,200})"|data-asin="(B0[A-Z0-9]{8})"[\s\S]{0,3000}?<img[^>]*alt="([^"]{10,200})"[^>]*src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) && results.length < 10) {
    const asin = m[1] || m[4];
    const title = (m[3] || m[5]).replace(/&amp;/g, "&").trim();
    const image = m[2] || m[6];
    if (!results.some((r) => r.asin === asin)) results.push({ asin, title, image });
  }
  return results;
}

const norm = (s) =>
  s.toLowerCase().replace(/[^a-z0-9äöüß ]/g, " ").split(/\s+/).filter((w) => w.length > 1);

/** Wortüberlappung zwischen Produktname und Suchtreffer-Titel (0..1).
 *  Tokens mit Ziffern (Modellnummern wie "i105e", "320", "m600") sind
 *  Pflicht — fehlt eine, ist es das falsche Modell → Score 0. */
function similarity(name, title) {
  const a = norm(name);
  const b = new Set(norm(title));
  if (!a.length) return 0;
  const modelTokens = a.filter((w) => /\d/.test(w));
  if (modelTokens.some((w) => !b.has(w))) return 0;
  return a.filter((w) => b.has(w)).length / a.length;
}

// Zubehör-Treffer aussortieren (Messer, Garagen, Ersatzteile …)
const ACCESSORY_RE =
  /\b(garage|messer|klingen?|ersatz|zubehör|abdeckung|hülle|halterung|kabel|ladestation[- ]?dach|reinigungs|kompatibel mit|für [A-ZÄÖÜ])/i;

/** Beste ASIN für einen Produktnamen (oder null, wenn kein guter Treffer). */
export async function findAsin(productName) {
  const hits = await searchAmazon(productName);
  let best = null;
  for (const h of hits) {
    if (ACCESSORY_RE.test(h.title)) continue;
    const score = similarity(productName, h.title);
    if (!best || score > best.score) best = { ...h, score };
  }
  // mind. 60 % der Namenswörter müssen im Treffer-Titel vorkommen
  return best && best.score >= 0.6 ? best : null;
}

/**
 * Prüft alle Produkte einer Kategorie und korrigiert ungültige ASINs
 * per Amazon-Suche. Mutiert die Produkte (asin, asinStatus) und liefert
 * einen Report zurück.
 */
export async function verifyProducts(products, onProgress = () => {}) {
  const report = [];
  for (const p of products) {
    onProgress(`prüfe: ${p.name}`);
    let entry = { name: p.name, asin: p.asin || "", status: "", fixedFrom: null };

    if (p.asin && (await checkAsin(p.asin))) {
      entry.status = "ok";
    } else {
      const old = p.asin || "";
      try {
        const found = await findAsin(`${p.brand || ""} ${p.name}`.trim());
        if (found) {
          p.asin = found.asin;
          if (found.image) p.image = found.image; // echtes Produktbild aus der Suche
          entry = { ...entry, asin: found.asin, status: "korrigiert", fixedFrom: old, matchTitle: found.title };
        } else {
          p.asin = "";
          entry.status = "nicht gefunden";
        }
      } catch (e) {
        entry.status = `Fehler: ${e.message}`;
      }
      await new Promise((r) => setTimeout(r, 5000)); // Amazon nicht hämmern
    }
    p.asinStatus = entry.status;
    p.asinCheckedAt = new Date().toISOString().slice(0, 10);
    report.push(entry);
  }
  return report;
}
