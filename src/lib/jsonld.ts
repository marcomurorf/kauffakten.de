import type { Category, Product } from "./categories";
import { SITE, productBuyUrl, productImageUrl } from "../config/site";

export function productJsonLd(p: Product, category: Category) {
  const image = productImageUrl(p);
  return {
    "@type": "Product",
    name: p.name,
    brand: { "@type": "Brand", name: p.brand },
    description: p.verdict,
    ...(image ? { image } : {}),
    offers: {
      "@type": "Offer",
      price: p.price.value,
      priceCurrency: p.price.currency,
      availability: "https://schema.org/InStock",
      url: productBuyUrl(p),
      priceValidUntil: p.price.checkedAt,
    },
    url: `${SITE.domain}/${category.slug}/#${p.id}`,
  };
}

export function categoryJsonLd(category: Category) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "ItemList",
        name: category.name,
        description: category.intro,
        numberOfItems: category.products.length,
        dateModified: category.updatedAt,
        itemListElement: category.products.map((p, i) => ({
          "@type": "ListItem",
          position: i + 1,
          item: productJsonLd(p, category),
        })),
      },
      {
        "@type": "FAQPage",
        mainEntity: category.faqs.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
      {
        "@type": "WebSite",
        name: SITE.name,
        url: SITE.domain,
        description: SITE.description,
      },
    ],
  };
}
