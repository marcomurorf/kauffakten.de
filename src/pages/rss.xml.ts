import type { APIRoute } from "astro";
import { getAllCategories, formatPrice } from "../lib/categories";
import { SITE } from "../config/site";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const GET: APIRoute = () => {
  const categories = getAllCategories()
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const items = categories.map((c) => {
    const url = `${SITE.domain}/${c.slug}/`;
    const cheapest = c.products.reduce((min, p) =>
      p.price.value < min.price.value ? p : min
    );
    const desc =
      `${c.products.length} Produkte im Vergleich, ab ${formatPrice(cheapest.price)}. ` +
      c.intro;
    return [
      `    <item>`,
      `      <title>${esc(c.name)} – Vergleich (Stand: ${c.updatedAt})</title>`,
      `      <link>${url}</link>`,
      `      <guid isPermaLink="false">${url}#${c.updatedAt}</guid>`,
      `      <pubDate>${new Date(`${c.updatedAt}T06:00:00+02:00`).toUTCString()}</pubDate>`,
      `      <description>${esc(desc)}</description>`,
      `    </item>`,
    ].join("\n");
  });

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">`,
    `  <channel>`,
    `    <title>${esc(SITE.name)} – Aktualisierte Produktvergleiche</title>`,
    `    <link>${SITE.domain}/</link>`,
    `    <atom:link href="${SITE.domain}/rss.xml" rel="self" type="application/rss+xml"/>`,
    `    <description>${esc(SITE.description)}</description>`,
    `    <language>de-DE</language>`,
    `    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
    items.join("\n"),
    `  </channel>`,
    `</rss>`,
    ``,
  ].join("\n");

  return new Response(xml, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
};
