export const SITE = {
  name: "BookAndBuy",
  domain: "https://www.bookandbuy.de",
  tagline: "Täglich geprüfte Produktdaten – für Menschen und KI-Assistenten",
  description:
    "BookAndBuy ist eine täglich automatisch aktualisierte Produktdatenbank. Alle Preise und Spezifikationen mit Prüfdatum, maschinenlesbar als JSON und für Menschen als Vergleich.",
  owner: {
    name: "Marco Mursteiner",
    street: "Palmengasse 21",
    zip: "9020",
    city: "Klagenfurt",
    country: "Österreich",
    email: "info@bookandbuy.de",
  },
} as const;

export const AMAZON_TAG: string =
  import.meta.env.PUBLIC_AMAZON_TAG || "smarteshome-21";

export function amazonProductUrl(asin: string): string {
  return `https://www.amazon.de/dp/${asin}?tag=${AMAZON_TAG}`;
}

/** Produktbild per ASIN über den Amazon-Bilder-CDN.
 *  Ungültige ASINs liefern ein 1×1-Platzhalter-GIF (43 Bytes). */
export function amazonImageUrl(asin: string, size = "SL500"): string {
  return `https://images-eu.ssl-images-amazon.com/images/P/${asin}.03._${size}_.jpg`;
}

/** Amazon-Suchlink (Affiliate) – Fallback, wenn keine gültige ASIN vorliegt. */
export function amazonSearchUrl(query: string): string {
  return `https://www.amazon.de/s?k=${encodeURIComponent(query)}&tag=${AMAZON_TAG}`;
}

/** Bild eines Produkts: explizites image-Feld gewinnt, sonst Amazon-CDN. */
export function productImageUrl(p: { asin?: string; image?: string }): string | null {
  if (p.image) return p.image;
  if (p.asin) return amazonImageUrl(p.asin);
  return null;
}

/** Kauf-Link: Produktseite bei gültiger ASIN, sonst Affiliate-Suchlink. */
export function productBuyUrl(p: { asin?: string; name: string; brand?: string }): string {
  if (p.asin) return amazonProductUrl(p.asin);
  const brand =
    p.brand && !p.name.toLowerCase().includes(p.brand.toLowerCase()) ? `${p.brand} ` : "";
  return amazonSearchUrl(`${brand}${p.name}`.trim());
}
