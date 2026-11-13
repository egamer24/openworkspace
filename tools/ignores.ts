/** Generated and vendored paths that oxlint and oxfmt leave alone. */
export const ignoredPaths = [
  "**/.alchemy",
  // Astro's generated content types.
  "**/.astro",
  "**/dist",
  "**/node_modules",
  // Drizzle output: SQL migrations, snapshots and the bundled `migrations.js`.
  "**/migrations",
  "packages/email/drizzle",
  // Vendored static assets.
  "**/public/pdfjs",
  "**/public/fonts",
  "**/workers-runtime.d.ts",
  // Vendored third-party lint rules, kept identical to upstream.
  "tools/oxlint/anti-slop",
  "**/playwright-report",
  "**/test-results",
  "exa-results",
  ".claude",
];
