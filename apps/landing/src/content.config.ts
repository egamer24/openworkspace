import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";

// The docs are the Markdown files in the repository's docs/ folder, the same
// files GitHub renders. Each file's name is its slug: docs/deploy.md is
// /docs/deploy.
const docs = defineCollection({
  loader: glob({ pattern: "*.md", base: "../../docs" }),
});

export const collections = { docs };
