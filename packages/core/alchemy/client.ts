import { cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import type { InlineConfig, Plugin } from "vite";

/** The package root, one up from alchemy/. */
const packageDir = resolve(import.meta.dirname, "..");

/** A module's part of the browser app. */
export type WorkspaceModuleClient = {
  /**
   * Absolute path of the module's client entry, which default-exports its
   * `ClientModule` (see `src/modules.ts`). Tailwind scans the entry's folder.
   */
  entry: string;
  /** Folders served as they are: `from` is copied to `/<to>` in the app. */
  assets?: { from: string; to: string }[];
};

const modulesId = "virtual:open-workspace/modules";

/**
 * Serves `virtual:open-workspace/modules`, the list of the modules' client
 * entries, and adds each entry's folder to Tailwind's sources.
 */
function workspaceModules(modules: WorkspaceModuleClient[]): Plugin {
  const styles = join(packageDir, "src", "styles.css");

  return {
    name: "open-workspace:modules",
    // Before Tailwind, which compiles styles.css.
    enforce: "pre",
    resolveId(source) {
      return source === modulesId ? `\0${modulesId}` : undefined;
    },
    load(id) {
      if (id !== `\0${modulesId}`) return undefined;

      return [
        ...modules.map(
          (module, index) =>
            `import module${index} from ${JSON.stringify(module.entry)};`
        ),
        `export default [${modules.map((_, index) => `module${index}`).join(", ")}];`,
      ].join("\n");
    },
    transform(code, id) {
      if (id.split("?")[0] !== styles) return undefined;

      return [
        code,
        ...modules.map(
          (module) => `@source ${JSON.stringify(dirname(module.entry))};`
        ),
      ].join("\n");
    },
  };
}

/**
 * Preloads the Latin Geist face that every first paint uses. Its file name
 * is content-hashed, so the link is added from the bundle at build time.
 */
function preloadMainFont(): Plugin {
  return {
    name: "open-workspace:preload-font",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        const font = Object.keys(context.bundle ?? {}).find((file) =>
          /(^|\/)geist-latin-wght-normal-[^/]*\.woff2$/u.test(file)
        );

        if (!font) return undefined;

        return [
          {
            tag: "link",
            attrs: {
              rel: "preload",
              as: "font",
              type: "font/woff2",
              href: `/${font}`,
              crossorigin: "",
            },
            injectTo: "head",
          },
        ];
      },
    },
  };
}

/**
 * Vite's config for the browser app with these modules. The app's root is
 * src/: index.html, the entry, and public/ (service worker, manifest,
 * icons, `_headers`).
 */
function clientConfig(props: {
  modules: WorkspaceModuleClient[];
  outDir: string;
}): InlineConfig {
  const appDir = join(packageDir, "src");

  return {
    configFile: false,
    root: appDir,
    logLevel: "warn",
    // React Compiler (oxc) memoizes components and hooks. Code it cannot
    // compile stays as written; `logDiagnostics: true` lists those places.
    plugins: [
      workspaceModules(props.modules),
      react({ compiler: true }),
      tailwindcss(),
      preloadMainFont(),
    ],
    resolve: {
      // Modules import these too; the app needs one copy of each.
      dedupe: [
        "react",
        "react-dom",
        "react-router",
        "@tanstack/react-query",
        "sonner",
      ],
    },
    build: { outDir: props.outDir, emptyOutDir: true },
  };
}

/** Builds the browser app from core's UI and the modules' client entries. */
export async function buildClient(props: {
  modules: WorkspaceModuleClient[];
  outDir: string;
}) {
  // Vite sets NODE_ENV for its build; leave the deploying process as it was.
  const nodeEnv = process.env.NODE_ENV;

  try {
    await build({ ...clientConfig(props), mode: "production" });
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }

  for (const asset of props.modules.flatMap((module) => module.assets ?? [])) {
    cpSync(asset.from, join(props.outDir, asset.to), { recursive: true });
  }

  return props.outDir;
}

// `bun run build`: core's app without modules, in dist/client, to check the
// build. Deployments build it with their modules (`OpenWorkspace`).
if (import.meta.main) {
  const outDir = join(packageDir, "dist", "client");
  await buildClient({ modules: [], outDir });
  console.log(`Built ${outDir}`);
}
