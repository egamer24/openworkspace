<p align="center">
  <img src=".github/assets/logo.svg" width="72" height="72" alt="">
</p>

<h1 align="center">OpenWorkspace</h1>

<p align="center">
  Team mail, passkey sign-in, and single sign-on for your other apps,<br>
  deployed to your own Cloudflare account.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@open-workspace/core"><img src="https://img.shields.io/npm/v/@open-workspace/core?label=%40open-workspace%2Fcore&color=355cd4" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-355cd4" alt="Apache-2.0 license"></a>
</p>

<p align="center">
  <a href="https://openworkspace.dev">Website</a> ·
  <a href="https://openworkspace.dev/docs">Docs</a> ·
  <a href="https://openworkspace.dev/docs/deploy">Deploy</a> ·
  <a href="https://openworkspace.dev/docs/configuration">Configuration</a> ·
  <a href="https://openworkspace.dev/docs/development">Development</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/mail-dark.webp">
  <img src=".github/assets/mail-light.webp" alt="The OpenWorkspace mail app: a mailbox list, an inbox, and an open conversation with two messages.">
</picture>

## Features

- Team mail: personal and shared inboxes and mailing lists across several
  domains, with delivery status, PDF and Office previews, translation, and AI
  spam checks and filing. Spam is emptied after 30 days by default.
- Passkey sign-in without passwords. People join with a one-time invitation
  link and recover access the same way.
- An identity provider for your other apps: OIDC and SAML sign-in, access by
  team, a groups claim, SCIM provisioning, and back-channel logout.
- MCP for AI agents and JMAP for mail apps, both signed in with OAuth and
  granular scopes. People see and disconnect them under **Settings → Connected
  apps**.
- Modules. Mail is a module on top of a core of people, teams, administration,
  signed webhooks, and MCP, and you can add your own.
- Everything runs in your Cloudflare account on Workers, D1, Durable Objects,
  R2, Queues, the Images binding, Email Service, and Containers. There is no
  per-seat pricing.

## Quick start

You need [Bun](https://bun.sh) and a Cloudflare account on the Workers Paid
plan, with your mail domains as zones in it.

```sh
bun create @open-workspace
```

It signs you in to Cloudflare, asks for your domains, and deploys. Then open
the app and create the first administrator with a passkey.

To move people and mail from Google Workspace or another provider, see
[Migration](https://openworkspace.dev/docs/migration).

## Documentation

|                                                               |                                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Deploy](https://openworkspace.dev/docs/deploy)               | Requirements, mail domains, optional setup, what a deploy creates                               |
| [Configuration](https://openworkspace.dev/docs/configuration) | `OpenWorkspace` props, AI providers and features, secrets                                       |
| [Using the workspace](https://openworkspace.dev/docs/mail)    | People, teams, mailboxes, notifications, previews, AI filing                                    |
| [Single sign-on](https://openworkspace.dev/docs/sso)          | OIDC, SAML, SCIM provisioning, apps declared in code                                            |
| [MCP and JMAP](https://openworkspace.dev/docs/mcp-and-jmap)   | Connecting agents and mail apps, OAuth scopes, connected apps                                   |
| [Webhooks](https://openworkspace.dev/docs/webhooks)           | Events, signatures, endpoints declared in code                                                  |
| [Migration](https://openworkspace.dev/docs/migration)         | Moving people, teams, and mail from Google Workspace, mbox or IMAP; the cutover                 |
| [Modules](https://openworkspace.dev/docs/modules)             | Writing your own module: the three halves, core's public API, migrations, testing, the scaffold |
| [`@open-workspace/core`](packages/core/README.md)             | The Alchemy API                                                                                 |
| [`@open-workspace/email`](packages/email/README.md)           | What the mail module adds to a deployment                                                       |

## Development

```sh
bun install
bun run dev          # core and mail with seeded demo data, at http://localhost:5173
bun run lint         # oxlint; bun run format runs oxfmt
bun run typecheck
bun run test         # unit and stack tests of every package
bun run test:e2e     # Playwright, desktop and mobile, then the Notes example
```

Choose **Open seeded local demo** to sign in without a passkey. Docker must be
running. More in [Development](https://openworkspace.dev/docs/development).

| Path                                             | What it is                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/core`](packages/core)                 | The platform: sign-in, people, teams, administration, OIDC/SAML/SCIM, webhooks, MCP, the browser app, and `OpenWorkspace` for Alchemy |
| [`packages/email`](packages/email)               | The mail module: mailboxes, delivery, previews, safety, AI, push, JMAP, and `Email()` for Alchemy                                     |
| [`packages/create`](packages/create)             | `bun create @open-workspace`, and its `import` and `module` commands                                                                  |
| [`examples/notes-module`](examples/notes-module) | A deployment with a small module of its own, built on core's public API                                                               |
| [`apps/landing`](apps/landing)                   | [openworkspace.dev](https://openworkspace.dev): the Astro site, the landing page and the docs built from `docs/`                      |

Each package has its own dev stack (`dev/`) and tests (`test/`).

## License

[Apache License 2.0](LICENSE)
