import { join } from "node:path";

import type { WorkspaceModuleInfra } from "@open-workspace/core/alchemy";

import { NOTES_MODULE } from "./shared/module";

/**
 * Notes' Alchemy half, listed in `OpenWorkspace({ modules: [Notes()] })`:
 * where its Worker code, its migrations and its part of the browser app are.
 * Notes keeps its data in the workspace's D1 database, so it declares no
 * resources of its own; a module that needs a bucket or a queue declares it
 * in `env` and `consumers`.
 */
export function Notes(): WorkspaceModuleInfra {
  return {
    name: NOTES_MODULE,
    server: { entry: join(import.meta.dirname, "index.ts") },
    migrations: join(import.meta.dirname, "migrations"),
    client: { entry: join(import.meta.dirname, "src", "client.tsx") },
  };
}
