import { z } from "zod";

/**
 * `bunx @open-workspace/create module <name>`: the files of a new module in
 * a deployment project (`modules/<name>/`), and the edits that wire it in.
 * Pure functions; module.ts writes their results.
 */

/** Module names: lowercase words joined by dashes. They also name scopes, so no digits. */
export const MODULE_NAME = /^[a-z]+(?:-[a-z]+)*$/u;

/** What the generated module imports, at the versions core is built with. */
export const moduleDependencies = {
  "@tanstack/react-query": "5.107.1",
  "drizzle-orm": "0.45.4",
  hono: "4.13.17",
  "lucide-react": "1.71.0",
  react: "19.3.1",
  "react-router": "8.5.1",
  zod: "4.6.7",
} satisfies Record<string, string>;

export const moduleDevDependencies = {
  "@types/react": "19.3.0",
  "drizzle-kit": "0.31.11",
} satisfies Record<string, string>;

export type ModuleNames = {
  /** The module's id and folder, e.g. "time-off". */
  name: string;
  /** Its Alchemy factory, e.g. "TimeOff". */
  pascal: string;
  /** Its server factory, e.g. "timeOff". */
  camel: string;
  /** Its constants' prefix, e.g. "TIME_OFF". */
  constant: string;
  /** Its scope group and table prefix, e.g. "time_off". */
  snake: string;
  /** What people read, e.g. "Time off". */
  label: string;
};

export function moduleNames(name: string): ModuleNames {
  if (!MODULE_NAME.test(name)) {
    throw new Error(
      `"${name}" is not a module name: use lowercase letters, words joined by dashes (e.g. time-off)`
    );
  }

  const words = name.split("-");
  const [first = "", ...rest] = words;

  const capital = (word: string) =>
    word.charAt(0).toUpperCase() + word.slice(1);

  return {
    name,
    pascal: words.map(capital).join(""),
    camel: first + rest.map(capital).join(""),
    constant: words.join("_").toUpperCase(),
    snake: words.join("_"),
    label: capital(words.join(" ")),
  };
}

/** The module's files, by path relative to the project. */
export function moduleFiles(names: ModuleNames) {
  const { name, pascal, camel, constant, snake, label } = names;
  const dir = `modules/${name}`;

  return {
    [`${dir}/shared/module.ts`]: `import type { WebhookEventDeclaration } from "@open-workspace/core/shared";

/**
 * The module's id, repeated by its three halves. Its migrations are
 * recorded as modules/${name}/<file>, so it never changes.
 */
export const ${constant}_MODULE = "${name}";

/** Where its app lives in the browser. */
export const ${constant}_PATH = "/${name}";

/** The OAuth scopes an app (an MCP client) needs for its routes and tools. */
export const ${constant}_READ_SCOPE = "${snake}.read";
export const ${constant}_WRITE_SCOPE = "${snake}.write";

/** The scopes as the consent screen lists them. An app that asks for nothing may read. */
export const ${camel}OauthScopes = {
  group: "${snake}",
  title: "${label}",
  scopes: [
    { id: ${constant}_READ_SCOPE, label: "Read your ${label.toLowerCase()} items", byDefault: true },
    { id: ${constant}_WRITE_SCOPE, label: "Add ${label.toLowerCase()} items as you" },
  ],
};

/** The webhook events the module sends, offered in the webhook editor. */
export const ${camel}WebhookEvents: Record<string, WebhookEventDeclaration> = {
  "${snake}.item_created": {
    label: "${label} item created",
    description: "When someone adds an item, with its title and author.",
  },
};
`,
    [`${dir}/worker/schema.ts`]: `import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "@open-workspace/core/module";

/**
 * The module's D1 tables, next to core's in the workspace's database. After
 * a change, \`bun run db:generate:${name}\` writes the migration.
 */
export const ${camel}Items = sqliteTable("${snake}_items", {
  id: text("id").primaryKey(),
  authorUserId: text("author_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql\`(unixepoch() * 1000)\`),
});
`,
    [`${dir}/worker/routes.ts`]: `import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  type AppEnv,
  createDb,
  createId,
  deferWebhookTask,
  oauthScope,
  queueWebhookEvent,
  requireAuth,
  zValidator,
} from "@open-workspace/core/module";
import { ${constant}_READ_SCOPE, ${constant}_WRITE_SCOPE } from "../shared/module";
import { ${camel}Items } from "./schema";

/** The signed-in person's items, under /api/${name}; each route names the scope a token needs. */
const items = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/", oauthScope(${constant}_READ_SCOPE), async (c) => {
    const rows = await createDb(c.env.DB).select().from(${camel}Items)
      .where(eq(${camel}Items.authorUserId, c.get("user").id))
      .orderBy(desc(${camel}Items.createdAt));
    return c.json({ ok: true as const, items: rows.map((row) => ({ id: row.id, title: row.title })) });
  })
  .post("/", oauthScope(${constant}_WRITE_SCOPE), zValidator("json", z.object({ title: z.string().trim().min(1).max(200) })), async (c) => {
    const user = c.get("user");
    const item = { id: createId("${snake.slice(0, 8)}"), title: c.req.valid("json").title };
    await createDb(c.env.DB).insert(${camel}Items).values({ ...item, authorUserId: user.id });
    deferWebhookTask((task) => c.executionCtx.waitUntil(task), (eventId) => queueWebhookEvent(c.env, {
      eventId,
      eventType: "${snake}.item_created",
      occurredAt: Date.now(),
      source: { kind: "data", data: { item, author: { id: user.id, name: user.name } } },
    }));
    return c.json({ ok: true as const, item }, 201);
  });

/** Routes under /api: the browser's, and the MCP tools' backend. */
export const ${camel}AccountApi = new Hono<AppEnv>().route("/${name}", items);

/** The routes as the browser's typed client sees them. */
export const ${camel}BrowserApi = new Hono<AppEnv>().route("/api", ${camel}AccountApi);
export type ${pascal}AppType = typeof ${camel}BrowserApi;
`,
    [`${dir}/worker/mcp.ts`]: `import { type McpToolRegistrar, runTool } from "@open-workspace/core/module";
import { ${constant}_READ_SCOPE } from "../shared/module";

/** MCP tools; each registered through \`tool(scope)\` and backed by the module's own routes. */
export const register${pascal}Tools: McpToolRegistrar = (tool, { api }) => {
  tool(${constant}_READ_SCOPE)(
    "list_${snake}_items",
    {
      title: "List ${label.toLowerCase()} items",
      description: "List the signed-in person's ${label.toLowerCase()} items, newest first.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => runTool(() => api.json("/${name}")),
  );
};
`,
    [`${dir}/worker/module.ts`]: `import type { WorkspaceModule } from "@open-workspace/core/module";
import { ${constant}_MODULE, ${camel}OauthScopes, ${camel}WebhookEvents } from "../shared/module";
import { ${camel}AccountApi } from "./routes";

/** The module's Worker half; the generated Worker entry calls this factory (../index.ts). */
export function ${camel}(): WorkspaceModule {
  return {
    name: ${constant}_MODULE,
    accountApi: ${camel}AccountApi,
    oauthScopes: ${camel}OauthScopes,
    webhookEvents: ${camel}WebhookEvents,
    mcpTools: () => import("./mcp").then((tools) => tools.register${pascal}Tools),
  };
}
`,
    [`${dir}/index.ts`]: `// The module's server entry: its default export is the factory of its WorkspaceModule.
export { ${camel} as default } from "./worker/module";
`,
    [`${dir}/alchemy.ts`]: `import { join } from "node:path";
import type { WorkspaceModuleInfra } from "@open-workspace/core/alchemy";
import { ${constant}_MODULE } from "./shared/module";

/** The module's Alchemy half: \`OpenWorkspace({ modules: [${pascal}()] })\`. */
export function ${pascal}(): WorkspaceModuleInfra {
  return {
    name: ${constant}_MODULE,
    server: { entry: join(import.meta.dirname, "index.ts") },
    migrations: join(import.meta.dirname, "migrations"),
    client: { entry: join(import.meta.dirname, "src", "client.tsx") },
  };
}
`,
    [`${dir}/src/client.tsx`]: `import { Boxes } from "lucide-react";
import { lazy } from "react";
import type { ClientModule } from "@open-workspace/core/ui";
import { ${constant}_MODULE, ${constant}_PATH, ${camel}WebhookEvents } from "../shared/module";

/** The module's part of the browser app; keep it light and lazy-load screens. */
const ${camel}Client: ClientModule = {
  name: ${constant}_MODULE,
  app: { label: "${label}", Icon: Boxes, path: ${constant}_PATH },
  routes: [{
    path: ${constant}_PATH,
    Component: lazy(() => import("./home").then((module) => ({ default: module.${pascal}Home }))),
  }],
  webhookEvents: ${camel}WebhookEvents,
};

export default ${camel}Client;
`,
    [`${dir}/src/home.tsx`]: `import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hc } from "hono/client";
import { useState, type FormEvent } from "react";
import {
  AppSwitcher,
  Button,
  Input,
  apiFetch,
  responseJson,
  useWorkspaceBrand,
  WorkspaceLogo,
} from "@open-workspace/core/ui";
import { ${constant}_MODULE } from "../shared/module";
import type { ${pascal}AppType } from "../worker/routes";

const api = hc<${pascal}AppType>(window.location.origin, { fetch: apiFetch });
const itemsKey = ["${name}", "items"] as const;

/** The app's screen: its header with the app switcher, a form, and the list. */
export function ${pascal}Home() {
  const brand = useWorkspaceBrand();
  const client = useQueryClient();
  const [title, setTitle] = useState("");
  const items = useQuery({ queryKey: itemsKey, queryFn: async () => responseJson(await api.api["${name}"].$get()) });
  const add = useMutation({
    mutationFn: async () => responseJson(await api.api["${name}"].$post({ json: { title } })),
    onSuccess: async () => {
      setTitle("");
      await client.invalidateQueries({ queryKey: itemsKey });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (title.trim()) add.mutate();
  }

  return (
    <div className="min-h-dvh bg-background">
      <header className="flex h-12 items-center gap-2.5 px-3 lg:px-4">
        <WorkspaceLogo src={brand.logoUrl} flat />
        <AppSwitcher current={${constant}_MODULE} />
      </header>
      <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 pt-8">
        <form onSubmit={submit} className="flex gap-2">
          <Input aria-label="Title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Add an item" />
          <Button type="submit" disabled={!title.trim() || add.isPending}>Add</Button>
        </form>
        <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-surface">
          {items.data?.items.map((item) => <li key={item.id} className="px-4 py-3 text-sm">{item.title}</li>)}
          {items.data?.items.length === 0 ? <li className="px-4 py-8 text-center text-sm text-muted-foreground">Nothing yet</li> : null}
        </ul>
      </main>
    </div>
  );
}
`,
    [`${dir}/drizzle.config.ts`]: `import { defineConfig } from "drizzle-kit";

// Migrations ship with the module and run on deploy, recorded as
// modules/${name}/<file>: never rename the module or a migration.
export default defineConfig({
  schema: "./worker/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
});
`,
    [`${dir}/tsconfig.json`]: `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          lib: ["ES2023", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          isolatedModules: true,
          resolveJsonModule: true,
          allowImportingTsExtensions: true,
          types: ["node"],
        },
        include: ["."],
      },
      null,
      2
    )}\n`,
  };
}

/** The lines that put the module in `alchemy.run.ts`, for people to add by hand. */
export function wiringLines(names: ModuleNames) {
  return {
    importLine: `import { ${names.pascal} } from "./modules/${names.name}/alchemy.ts";`,
    entry: `${names.pascal}()`,
  };
}

/**
 * `alchemy.run.ts` with the module imported and listed in `modules`, or null
 * when that cannot be done safely: no single `modules: [...]` on one line.
 * An already wired file comes back unchanged.
 */
export function wireAlchemyRun(
  source: string,
  names: ModuleNames
): string | null {
  const { importLine, entry } = wiringLines(names);

  if (source.includes(importLine)) return source;

  const lists = [
    ...source.matchAll(/^(\s*modules:\s*\[)([^\]\n]*)(\],?)\s*$/gmu),
  ];

  const imports = [...source.matchAll(/^import .*;\s*$/gmu)];
  const [list] = lists;
  const lastImport = imports.at(-1);

  if (lists.length !== 1 || !list || !lastImport) return null;
  const [line, opening, listItems, closing] = list;
  const items = listItems.trim();
  const listed = `${opening}${items ? `${items.replace(/,\s*$/u, "")}, ` : ""}${entry}${closing}`;

  let wired =
    source.slice(0, list.index) +
    listed +
    source.slice(list.index + line.replace(/\s*$/u, "").length);

  const end = lastImport.index + lastImport[0].trimEnd().length;
  wired = `${wired.slice(0, end)}\n${importLine}${wired.slice(end)}`;

  return wired;
}

const stringRecord = z.record(z.string(), z.string());

/** A package.json, the fields edited here; every other field is kept as it is. */
const packageManifestSchema = z.looseObject({
  dependencies: stringRecord.optional(),
  devDependencies: stringRecord.optional(),
  scripts: stringRecord.optional(),
});

/**
 * The project's package.json with what the module needs added: its
 * dependencies (versions already there are kept) and its migration script.
 */
export function withModuleDependencies(
  packageJson: string,
  names: ModuleNames
) {
  const manifest = packageManifestSchema.parse(JSON.parse(packageJson));

  manifest.dependencies = { ...moduleDependencies, ...manifest.dependencies };
  manifest.devDependencies = {
    ...moduleDevDependencies,
    ...manifest.devDependencies,
  };
  manifest.scripts = {
    ...manifest.scripts,
    [`db:generate:${names.name}`]: `cd modules/${names.name} && drizzle-kit generate`,
  };

  const sort = (record: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(record).sort(([a], [b]) => a.localeCompare(b))
    );

  manifest.dependencies = sort(manifest.dependencies);
  manifest.devDependencies = sort(manifest.devDependencies);

  return `${JSON.stringify(manifest, null, 2)}\n`;
}
