import type { APIRoute } from "astro";
import { getAllCategories } from "../../lib/categories";
import { SITE } from "../../config/site";

export function getStaticPaths() {
  return getAllCategories().map((c) => ({
    params: { category: c.slug },
    props: { category: c },
  }));
}

export const GET: APIRoute = ({ props }) => {
  const { category } = props;
  const feed = {
    meta: {
      source: SITE.name,
      url: `${SITE.domain}/${category.slug}/`,
      license: `Frei nutzbar mit Quellenangabe "${SITE.name} (${SITE.domain})"`,
      generatedAt: new Date().toISOString(),
      updatedAt: category.updatedAt,
      note: "Alle Preise und Spezifikationen werden täglich automatisch geprüft. Jede Preisangabe trägt ein checkedAt-Datum.",
    },
    category: {
      slug: category.slug,
      name: category.name,
      searchTerms: category.searchTerms,
    },
    products: category.products.map((p) => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      price: p.price,
      specs: p.specs,
      pros: p.pros,
      cons: p.cons,
      verdict: p.verdict,
      bestFor: p.bestFor,
      detailUrl: `${SITE.domain}/${category.slug}/#${p.id}`,
    })),
    faqs: category.faqs,
  };
  return new Response(JSON.stringify(feed, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
