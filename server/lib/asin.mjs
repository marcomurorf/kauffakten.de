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

// Mobile-UA: Desktop-UAs bekommen von Amazon inzwischen nur noch eine
// bm-verify-Bot-Challenge bzw. 503 — der mobile Endpunkt liefert die
// Suchergebnisse weiterhin ungebremst aus.
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// Suchdomains in Reihenfolge: amazon.de bevorzugt; blockt Amazon die IP
// (503 / bm-verify — trifft z. B. die VPS-IP), weichen wir auf andere
// EU-Marketplaces aus. ASINs sind EU-weit identisch, Preise in € ähnlich.
const SEARCH_DOMAINS = ["www.amazon.de", "www.amazon.nl", "www.amazon.fr"];

/** Amazon-Suche → [{ asin, title, image, price, sponsored }] der Treffer.
 *  Bei 503/Bot-Challenge: Retry, dann Fallback auf andere EU-Domain. */
export async function searchAmazon(query) {
  let html = null;
  let lastStatus = 0;
  outer: for (const domain of SEARCH_DOMAINS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 6_000));
      let res;
      try {
        res = await fetch(`https://${domain}/s?k=${encodeURIComponent(query)}`, {
          headers: {
            "User-Agent": MOBILE_UA,
            "Accept-Language": "de-DE,de;q=0.9",
            Accept: "text/html",
          },
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        continue;
      }
      lastStatus = res.status;
      if (!res.ok) continue;
      const body = await res.text();
      // Bot-Challenge (bm-verify) kommt als HTTP 200 mit Mini-HTML zurück
      if (!body.includes("bm-verify") && body.length > 50_000) {
        html = body;
        break outer;
      }
    }
  }
  if (!html) throw new Error(`Amazon-Suche blockiert (HTTP ${lastStatus})`);

  // Treffer hängen am Produkt-Titel (<h2 aria-label="…">); die zugehörige
  // ASIN steht im /dp/-Link direkt danach, der Preis (a-price-whole) ebenso.
  const decode = (s) =>
    s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
  const results = [];
  const h2Re = /<h2[^>]*aria-label="([^"]{15,300})"[^>]*>/g;
  let m;
  while ((m = h2Re.exec(html)) && results.length < 12) {
    let title = m[1];
    if (/Ähnliche Produkte|Anzeigenfeedback|Vergelijkbare|similaires/i.test(title)) continue;
    const sponsored = /^(Gesponserte Anzeige|Gesponsord|Annonce sponsoris)/i.test(title);
    title = decode(title.replace(/^(Gesponserte Anzeige|Gesponsord[^–—]*|Annonce sponsoris[^–—]*)\s*[–—]\s*/i, ""));
    const after = html.slice(m.index, m.index + 9_000);
    const asin = after.match(/\/dp\/(B0[A-Z0-9]{8})/)?.[1];
    if (!asin || results.some((r) => r.asin === asin)) continue;
    const priceMatch = after.match(/a-price-whole">([\d.]{1,7})/);
    const price = priceMatch ? Number(priceMatch[1].replace(/\./g, "")) : null;
    // Produktbild deterministisch über den Bilder-CDN (gehört sicher zur ASIN)
    results.push({ asin, title, image: asinImageUrl(asin), price, sponsored });
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
