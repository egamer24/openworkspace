# Modules

A module adds an app to the workspace. It can bring its own database tables,
API routes, MCP tools, permissions and OAuth scopes, webhook events, and
screens: an app in the switcher, Settings sections, and Administration
sections. Mail ([`@open-workspace/email`](../packages/email/README.md)) is a
module.

You write a module inside your deployment project and list it in
`alchemy.run.ts`. Each deploy builds the listed modules and applies their
migrations, so you don't register or publish anything.

```ts
// alchemy.run.ts
import { Email } from "@open-workspace/email/alchemy";

import { Notes } from "./modules/notes/alchemy.ts";

OpenWorkspace({
  hostname: "mail.acme.com",
  mailDomains: ["acme.com"],
  modules: [Email(), Notes()],
});
```

For a complete working example, read
[`examples/notes-module`](../examples/notes-module). It has every part this page
mentions.

## Scaffold

In your deployment project, run:

```sh
bunx @open-workspace/create module time-off
```

This writes `modules/time-off/` with a table, an API route with read and write
scopes, an MCP tool, a webhook event, and an app at `/time-off`. It also adds
the dependencies and a `db:generate:time-off` script to `package.json`, and
lists `TimeOff()` in `alchemy.run.ts`. If it can't safely edit
`alchemy.run.ts`, it prints the lines to add instead.

Then:

1. `bun install`
2. `bun run db:generate:time-off` to create the first migration
3. `bun run deploy`

The scaffold leaves out Settings, Administration and permissions. Copy them
from Notes when you need them.

## How a module is built

A module has three parts. Code they share (ids, scopes, permissions, webhook
events) goes in the module's `shared/` folder and imports only
`@open-workspace/core/shared`.

| Part    | Type                   | Runs           | What it declares                                                                                |
| ------- | ---------------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| Alchemy | `WorkspaceModuleInfra` | On deploy      | The module's `name`, its entry files and migrations, and the Cloudflare resources it binds      |
| Server  | `WorkspaceModule`      | In the Worker  | Routes, permissions, OAuth scopes, MCP tools, webhook events, and queue, mail and cron handlers |
| Client  | `ClientModule`         | In the browser | The app in the switcher, its screens, and Settings and Administration sections                  |

```ts
// modules/notes/alchemy.ts
export function Notes(): WorkspaceModuleInfra {
  return {
    name: NOTES_MODULE, // "notes", never changed
    server: { entry: join(import.meta.dirname, "index.ts") },
    migrations: join(import.meta.dirname, "migrations"),
    client: { entry: join(import.meta.dirname, "src", "client.tsx") },
  };
}
```

## Public API

Import core only through these entry points. Anything else in core can change
in any release. Each entry file links to the types' doc comments, which are the
reference.

| Entry                                                                       | Where it runs | What's in it                                                                                                           |
| --------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [`@open-workspace/core/alchemy`](../packages/core/alchemy/index.ts)         | Deploy        | `OpenWorkspace`, `WorkspaceModuleInfra`, `OidcClient`, `SamlApp`, `Webhook`, and their types                           |
| [`@open-workspace/core/module`](../packages/core/worker/module-api.ts)      | Worker        | `WorkspaceModule`, auth and permission middleware, the database and core's tables, MCP and webhook helpers, AI helpers |
| [`@open-workspace/core/shared`](../packages/core/shared/index.ts)           | Both          | Permission and webhook event types, email address helpers, `invariant`, `required`                                     |
| [`@open-workspace/core/ui`](../packages/core/src/ui.ts)                     | Browser       | `ClientModule`, UI components, admin panel layout, `AppSwitcher`, `useAuth`, the API client                            |
| [`@open-workspace/core/dev`](../packages/core/dev/stack.ts)                 | Local         | `devWorkspaceStack`, `demoSeed`                                                                                        |
| [`@open-workspace/core/testing`](../packages/core/testing/index.ts)         | `bun test`    | `testWorkspaceStack`, `deployTestStack`, `useFreshWorkspace`, MCP token helpers                                        |
| [`@open-workspace/core/testing/worker`](../packages/core/testing/worker.ts) | Test Worker   | `testWorker` and test hooks                                                                                            |
| [`@open-workspace/core/testing/e2e`](../packages/core/testing/e2e.ts)       | Playwright    | `e2eConfig`, `deployE2eStack`                                                                                          |

## Tables and migrations

Your tables live in the workspace's D1 database, next to core's, and can
reference core's tables such as `users.id`. Declare them with Drizzle and
generate migrations with `drizzle-kit generate`. Read and write with
`createDb(c.env.DB)`.

Once you've deployed, keep these stable:

- The module's `name`. Renaming it makes every migration run again.
- Migration files. Add new ones; never edit, rename or delete a deployed one.

Prefix table names with the module's name (Notes uses `notes` and
`note_preferences`), because all modules share one namespace.

## Routes, scopes and permissions

Routes are Hono apps mounted under `/api`. Put `requireAuth` in front, and give
each route the OAuth scope a token needs with `oauthScope(...)`. A route
without a scope refuses tokens. Browser sessions don't use scopes.

```ts
const ownNotes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/", oauthScope(NOTES_READ_SCOPE), async (c) => { … })
  .post("/", oauthScope(NOTES_WRITE_SCOPE), zValidator("json", noteInputSchema), async (c) => { … });
```

- Scopes are named `area.name`, in lowercase letters and underscores. Mark the
  everyday ones `byDefault`.
- Permissions are what an administrator can grant a member. Guard their
  routes with `requirePermission(id)`, under `/api/admin/<section>`.
- A `teamAddress` section on `ClientModule` adds settings to a team's address
  under **Administration → Teams**, such as a shared inbox's signature. It
  has no save button of its own: call `useAddressSection({ dirty, save })`
  from `@open-workspace/core/ui`. "Save address" is enabled when the address
  or any section is `dirty`. It saves the address first, then calls `save`
  for each dirty section, and closes the editor only if all of them succeed.
  If a `save` throws, its message is shown and the editor stays open. `save`
  goes through your own routes; guard them with
  `requirePermission("manage_teams")`. The section gets the form's current
  `delivery` (and a forward's `forwardTo`), so it can hide as soon as the
  delivery changes: unmount the component that calls `useAddressSection`,
  and it stops taking part.
- A `userAddress` section does the same for a person's address under
  **Administration → People**; guard its routes with
  `requirePermission("manage_people")`.
- An address delivers as `inbox` (its own mailbox), `list` (a team's mailing
  list), `alias` (into the mailbox `aliasOf`) or `forward` (to the outside
  addresses `forwardTo`), and an inbox may be its domain's `catchAll`.
  `hooks.mailboxSaved` runs after an address is created or changed, and
  `hooks.mailboxDeleted` after one is deleted. Deleting a mailbox deletes its
  aliases first, so both run for each of them.
- Register MCP tools through `tool(scope)`, and implement them by calling your
  own routes through `api`, so a token only sees what its scopes allow.
- Declare webhook events once in `shared/`, on both the server and client
  parts, and send them with `queueWebhookEvent`.

The Worker refuses to start if two modules use the same name, permission,
scope, or webhook event.

## Screens

The client entry exports a `ClientModule`. Load every screen with `lazy()`.

- Build screens from `@open-workspace/core/ui`, and start a full-page app's
  header like the others: the workspace logo, `<AppSwitcher current={MODULE} />`,
  and the account menu.
- Use the theme's color tokens (`bg-surface`, `text-muted-foreground`, …) so
  light and dark mode both work.
- Keep the screens in the client entry's folder, because Tailwind only scans
  that folder.
- In `package.json`, list React, React Router, TanStack Query and sonner at
  core's versions, if the module imports them.

## Test locally

`@open-workspace/core/dev` runs the workspace on your computer with demo data
and a demo sign-in. You don't need a Cloudflare account.

```ts
// dev.run.ts
const { stack, stackName } = devWorkspaceStack({
  stack: "NotesExampleDev",
  modules: [Notes()],
  seed: [demoSeed],
  port: 5180,
});
export { stackName };
export default stack;
```

Run `ALLOW_MOCK_AUTH=true alchemy dev dev.run.ts`, open the app, and choose
**Open seeded local demo**.

For automated tests, see how the Notes example uses
`@open-workspace/core/testing` and `/testing/e2e`. Projects that use them need
`@alchemy.run/test` in their devDependencies, and Playwright must run under Bun
(`bun --bun playwright test`).
