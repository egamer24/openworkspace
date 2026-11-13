import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

import { ignoredPaths } from "./tools/ignores.ts";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [...ultracite.ignorePatterns, ...ignoredPaths],
  // Keep the docs' hand-wrapped prose; ultracite's "never" would unwrap every paragraph.
  proseWrap: "preserve",
  // .astro files go through prettier-plugin-astro (with the root's
  // @astrojs/compiler-rs). The landing page sets `compressHTML: false`, so the
  // formatter must treat its whitespace as significant too.
  astro: { compressHTML: "none" },
});
