# anti-slop (vendored)

Oxlint JS plugins from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop),
registered in the root `oxlint.config.ts` (`anti-slop` for all TS/JS,
`anti-slop-effect` for the Effect code only).

- Upstream commit: `13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-13)
- License: MIT, Copyright (c) 2026 Dillon Mulroy (`LICENSE`). The padding-line
  engine in `vendor/eslint-stylistic/` is MIT, OpenJS Foundation and ESLint
  Stylistic contributors (`vendor/eslint-stylistic/LICENSE`, `UPSTREAM.md`).
- Copied: upstream `src/` without its `*.test.ts` files (they need
  `oxlint/plugins-dev`, `tsx` and pnpm). No local changes.

The plugin only reads the AST through `@oxlint/plugins`: it has no network or
file-system access, and its only fixes are whitespace (`require-readable-spacing`).
`@oxlint/plugins` must stay at exactly the same version as `oxlint`.

## Updating

1. Clone upstream into a temporary directory and pick a commit. Do not run
   `npx skills add`.
2. Review `git diff <old>..<new> -- src` upstream. The code runs inside every
   lint, so check that it still only inspects the AST.
3. Replace this directory's files with the new `src/` (minus `*.test.ts`),
   keeping `SOURCE.md` and both `LICENSE` files.
4. Update the commit above, and enable any new rules in `oxlint.config.ts`.
5. If upstream moved to a newer `@oxlint/plugins`, bump `oxlint` and
   `@oxlint/plugins` together to the same exact version.
6. Run `bun run lint`.
