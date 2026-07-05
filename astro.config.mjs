import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://www.kauffakten.de",
  integrations: [
    tailwind(),
    sitemap({
      filter: (page) =>
        !page.includes("/impressum/") && !page.includes("/datenschutz/"),
      serialize: (item) => ({
        ...item,
        lastmod: new Date().toISOString(),
      }),
    }),
  ],
  compressHTML: true,
  build: { inlineStylesheets: "auto" },
});
