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
