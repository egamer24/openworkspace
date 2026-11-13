// Builds the docs' search index with Pagefind once Astro has written the
// site. Only the docs' articles carry data-pagefind-body, so the landing
// page and the 404 page stay out of it. The index lands in dist/pagefind/,
// which the search dialog loads on first use.

import { fileURLToPath } from "node:url";

import type { AstroIntegration } from "astro";
import { close, createIndex } from "pagefind";

export function pagefind(): AstroIntegration {
  return {
    name: "docs-pagefind",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const outDir = fileURLToPath(dir);
        const { index, errors } = await createIndex();

        if (!index) throw new Error(`Pagefind: ${errors.join("; ")}`);

        const indexed = await index.addDirectory({ path: outDir });

        const written = await index.writeFiles({
          outputPath: `${outDir}/pagefind`,
        });

        const problems = [...indexed.errors, ...written.errors];

        await close();

        if (problems.length > 0) {
          throw new Error(`Pagefind: ${problems.join("; ")}`);
        }

        logger.info(`Indexed ${indexed.page_count} docs pages for search.`);
      },
    },
  };
}
