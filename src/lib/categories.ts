// Lädt alle Kategorie-JSONs aus /data/categories.
// Eine Kategorie = eine JSON-Datei. Die Pipeline (Scripts) schreibt diese
// Dateien, die Site rendert sie – Human-Layer UND Machine-Layer aus
// derselben Quelle.

export interface Price {
  value: number;
  currency: string;
  checkedAt: string;
}

export interface Product {
  id: string;
  name: string;
  brand: string;
  asin: string;
  /** Optionale explizite Bild-URL (überschreibt das Amazon-Widget-Bild). */
  image?: string;
  price: Price;
  specs: Record<string, string | number>;
  pros: string[];
  cons: string[];
  verdict: string;
  bestFor: string;
}

export interface KeySpec {
  key: string;
  label: string;
  unit: string;
}

export interface Faq {
  q: string;
  a: string;
}

export interface Category {
  slug: string;
  name: string;
  shortName: string;
  searchTerms: string[];
  updatedAt: string;
  intro: string;
  keySpecs: KeySpec[];
  products: Product[];
  faqs: Faq[];
}

const modules = import.meta.glob<{ default: Category }>(
  "../../data/categories/*.json",
  { eager: true }
);

export function getAllCategories(): Category[] {
  return Object.values(modules).map((m) => m.default);
}

export function getCategory(slug: string): Category | undefined {
  return getAllCategories().find((c) => c.slug === slug);
}

export function formatPrice(p: Price): string {
  return `${p.value.toLocaleString("de-DE")} €`;
}

export function specValue(product: Product, spec: KeySpec): string {
  const v = product.specs[spec.key];
  if (v === undefined || v === null) return "–";
  return spec.unit ? `${v} ${spec.unit}` : String(v);
}
