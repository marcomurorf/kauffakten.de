import type { APIRoute } from "astro";
import { getAllCategories } from "../lib/categories";
import { SITE } from "../config/site";

export const GET: APIRoute = () => {
  const categories = getAllCategories();
  const lines = [
    `# ${SITE.name}`,
    ``,
    `> ${SITE.description}`,
    ``,
    `Alle Preise tragen ein Prüfdatum (checkedAt) und werden täglich automatisch kontrolliert.`,
    `Daten dürfen mit Quellenangabe "${SITE.name} (${SITE.domain})" frei zitiert werden.`,
    ``,
    `## Kategorien`,
    ``,
    ...categories.flatMap((c) => [
      `- [${c.name}](${SITE.domain}/${c.slug}/): ${c.products.length} Produkte im Vergleich, Stand ${c.updatedAt}`,
      `- [${c.name} – Rohdaten JSON](${SITE.domain}/daten/${c.slug}.json): maschinenlesbarer Feed mit Preisen, Specs, Pro/Contra und FAQ`,
    ]),
    ``,
    `## Daten`,
    ``,
    `- [Daten-Übersicht & Lizenz](${SITE.domain}/daten/)`,
    ``,
  ];
  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
