# Development

This page is for people working on the OpenWorkspace repository itself.

## Repository layout

| Path                    | What's there                                                              |
| ----------------------- | ------------------------------------------------------------------------- |
| `packages/core`         | The workspace: accounts, teams, SSO, MCP, webhooks, the browser app shell |
| `packages/email`        | The mail module                                                           |
| `packages/create`       | `bun create @open-workspace`, and the `import` and `module` commands      |
| `examples/notes-module` | A deployment project with a small example module                          |
| `apps/landing`          | [openworkspace.dev](https://openworkspace.dev), including these docs      |
| `docs`                  | These docs                                                                |
| `tools/oxlint`          | Vendored lint rules                                                       |
| `scripts/release.ts`    | Publishes the packages to npm                                             |

The packages are published as TypeScript. On deploy, `OpenWorkspace` generates
the Worker entry and builds the browser app from the listed modules, into
`.alchemy/openworkspace/<stack>/<stage>/`.

## Run locally

You need [Bun](https://bun.sh) at the version in `package.json`'s
`packageManager`, and Docker for the Office preview container, the stack tests,
and the e2e suites.

```sh
bun install
bun run dev
```

This serves core and `Email()` at [http://localhost:5173](http://localhost:5173).
Choose **Open seeded local demo** to sign in without a passkey. The demo has an
administrator, a member, an invited person, teams, and sample mail on
`demo.example`. Mail you send locally is written to `.alchemy/local/email`.

To try the invitation and recovery screens, open
`/invite/demo-invitation-token` (signed out) or
`/recover/demo-recovery-token`.

`bun run dev` in `packages/core` serves core alone, without modules, on port 5175.

Locally, image resizing is emulated with Sharp. It fits non-square images
inside the square instead of cropping them as production does.

## Checks

```sh
bun run lint           # oxlint; lint:fix applies safe fixes
bun run format         # oxfmt; format:check only reports
bun run typecheck
bun run test           # unit and stack tests in every package
bun run test:e2e       # Playwright for core and email, then the Notes example
```

Lint and format use [Ultracite](https://www.ultracite.ai)'s oxlint and oxfmt
presets plus the vendored [anti-slop](../tools/oxlint/anti-slop/SOURCE.md)
rules. Every rule that's turned off says why in `oxlint.config.ts`. To disable a
rule on one line, write `// oxlint-disable-next-line rule -- reason`.

CI runs lint, the format check, typecheck and unit tests on pull requests and
pushes to `master`. Run the stack and e2e suites locally.

## Tests

Tests live in the package they test:

- `test/unit` runs with plain `bun test` and needs no Worker.
- `test/stack` deploys a real stack in Alchemy's local runtime and drives it
  over HTTP. A test Worker adds routes under `/api/__test` to reach the
  database, storage, queues, inbound mail, and the cron. Each file starts from
  an empty workspace.
- `test/e2e` runs Playwright (desktop and mobile) against the package's dev
  stack.

The test helpers in `packages/core/testing` are published, so module authors
can use them too.

Each run uses its own stage (`test_$USER`, `e2e_$USER`, `dev_$USER`), so dev,
stack and e2e runs can happen at the same time.

`bun run test:example` packs core, copies the Notes example out of the
repository, installs it, adds a module with the scaffold, and runs its tests.
Add `--keep` to look at the project afterwards.

## Schema changes

Run `bun run db:generate` in the package that owns the table. In
`packages/email` this generates both the D1 migrations and the mailbox's own
database migrations. SQL that Drizzle can't express goes in a custom migration
(`drizzle-kit generate --custom`). There are no database triggers.

## Docs and website

The site in `apps/landing` builds its `/docs/<name>` pages from this `docs/`
folder. Link between docs with relative paths, such as
`[Webhooks](webhooks.md#verify-deliveries)`; the build turns them into site
links. A new doc also needs an entry in `apps/landing/src/docs.ts`.

```sh
bun run dev:site       # http://localhost:4321
bun run build:site
bun run preview:site
```

Pushes to `master` that change the site or `docs/` deploy it
(`.github/workflows/landing.yml`); `bun run deploy` in `apps/landing` deploys
it by hand.

## Release

Push a `v*` tag. The release workflow publishes core, email and create to npm
with trusted publishing. The tag must match the version in every package. A
version already on npm is skipped, so you can re-run a failed release.
