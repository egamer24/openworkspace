import { fileURLToPath } from "node:url";

import { satteri } from "@astrojs/markdown-satteri";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

import { pagefind } from "./src/integrations/pagefind.ts";
import { codeBlocks } from "./src/markdown/code-blocks.ts";
import { codeThemes } from "./src/markdown/code-themes.ts";
import { docsMarkdown } from "./src/markdown/docs-markdown.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig({
  site: "https://openworkspace.dev",
  output: "static",
  // `/docs/deploy` is `docs/deploy.html`, which Cloudflare's
  // auto-trailing-slash handling serves without a trailing slash.
  build: { format: "file" },
  trailingSlash: "never",
  // The landing page's markup is hand-wrapped, and some of its spacing lives
  // in the line breaks between inline elements. Astro 7's default `"jsx"`
  // whitespace rules would drop them.
  compressHTML: false,
  devToolbar: { enabled: false },
  vite: { plugins: [tailwindcss()] },
  integrations: [
    sitemap({
      filter: (page) => !page.endsWith("/404"),
      lastmod: new Date(),
    }),
    pagefind(),
  ],
  markdown: {
    processor: satteri({ hastPlugins: docsMarkdown(repoRoot) }),
    shikiConfig: {
      themes: codeThemes,
      defaultColor: false,
      wrap: false,
      transformers: [codeBlocks],
    },
  },
});
