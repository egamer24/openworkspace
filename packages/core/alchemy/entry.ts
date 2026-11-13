import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { WorkspaceConfigInput } from "../worker/config/schema.ts";

/** A value that can be written into the generated Worker entry as it is. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/**
 * Server code the generated Worker entry imports: a module that exports a
 * factory, and the Durable Object and Container classes it exports too.
 */
export type WorkspaceServerEntry = {
  /**
   * Absolute path or package specifier of the module, e.g. the path of the
   * package's index.ts. Package specifiers resolve from the deployment's
   * project directory.
   */
  entry: string;
  /** The factory's export; the default export when left out. */
  export?: string;
  /** Passed to the factory as its argument; omitted when left out. */
  options?: Json;
  /**
   * Durable Object and Container classes `entry` exports. The Worker
   * re-exports them, so bindings can name them as `className`.
   */
  classes?: string[];
};

/** Core's runtime: `createWorkspace`. */
const coreEntry = resolve(import.meta.dirname, "..", "worker", "index.ts");

/**
 * An import specifier for `entry`: absolute paths by their real location,
 * so a module the entry and a package both import is bundled once (module
 * state such as the installed modules lives in core's files).
 */
function specifier(entry: string) {
  return JSON.stringify(
    isAbsolute(entry) && existsSync(entry) ? realpathSync(entry) : entry
  );
}

function importLine(server: WorkspaceServerEntry, local: string) {
  return server.export && server.export !== "default"
    ? `import { ${server.export} as ${local} } from ${specifier(server.entry)};`
    : `import ${local} from ${specifier(server.entry)};`;
}

function call(local: string, server: WorkspaceServerEntry, ...first: string[]) {
  const args = [
    ...first,
    ...(server.options === undefined ? [] : [JSON.stringify(server.options)]),
  ];

  return `${local}(${args.join(", ")})`;
}

/**
 * The source of a workspace's Worker entry: `createWorkspace` with the
 * workspace's configuration and each module's server factory, the classes
 * the modules export, and, for test Workers, a `wrap` around the handlers
 * whose classes take the place of the modules' classes of the same name.
 */
export function workerEntrySource(props: {
  /** `createWorkspace`'s settings, written into the entry as JSON. */
  config: WorkspaceConfigInput;
  modules: { name: string; server: WorkspaceServerEntry }[];
  wrap?: WorkspaceServerEntry;
}) {
  const classes = new Map<string, WorkspaceServerEntry>();

  for (const { name, server } of props.modules) {
    for (const className of server.classes ?? []) {
      if (classes.has(className)) {
        throw new Error(
          `Module ${name} exports ${className}, which another module exports`
        );
      }

      classes.set(className, server);
    }
  }

  const { wrap } = props;

  for (const className of wrap?.classes ?? []) {
    if (wrap) classes.set(className, wrap);
  }

  const bySource = new Map<string, string[]>();

  for (const [className, server] of classes) {
    bySource.set(server.entry, [
      ...(bySource.get(server.entry) ?? []),
      className,
    ]);
  }

  const workspace = `createWorkspace({ ...config, modules: [${props.modules
    .map(({ server }, index) => call(`module${index}`, server))
    .join(", ")}] })`;

  return [
    "// The workspace's Worker entry, written by OpenWorkspace on every deploy",
    "// from alchemy.run.ts. Do not edit; it is replaced.",
    `import { createWorkspace } from ${specifier(coreEntry)};`,
    ...props.modules.map(({ server }, index) =>
      importLine(server, `module${index}`)
    ),
    ...(props.wrap ? [importLine(props.wrap, "wrap")] : []),
    "",
    ...(bySource.size
      ? [
          "// Durable Object and Container classes, for the bindings that name them.",
        ]
      : []),
    ...[...bySource].map(
      ([entry, names]) =>
        `export { ${names.join(", ")} } from ${specifier(entry)};`
    ),
    ...(bySource.size ? [""] : []),
    `const config = ${JSON.stringify(props.config, null, 2)};`,
    "",
    `export default ${props.wrap ? call("wrap", props.wrap, workspace) : workspace};`,
    "",
  ].join("\n");
}

/**
 * Writes the Worker entry to `<dir>/worker.ts` and returns its path. An
 * unchanged entry is left as it is, so `alchemy dev` doesn't rebuild for it.
 */
export function writeWorkerEntry(dir: string, source: string) {
  const file = join(dir, "worker.ts");
  mkdirSync(dir, { recursive: true });

  if (!existsSync(file) || readFileSync(file, "utf-8") !== source) {
    writeFileSync(file, source);
  }

  return file;
}
