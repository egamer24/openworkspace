#!/usr/bin/env bun
/**
 * Runs the Notes example as a deployment project outside this repository:
 * packs @open-workspace/core as npm would publish it, copies the example to
 * a temporary directory, installs the tarball and the example's other
 * dependencies there with `bun install` (nothing resolves from the
 * monorepo), adds a module with the scaffold (`create module tasks`),
 * typechecks it all, and runs the example's Playwright suite, which deploys
 * core and Notes on Alchemy's local runtime.
 *
 *   bun examples/notes-module/test/outside-monorepo.ts [--keep] [-- playwright args]
 *
 * `--keep` leaves the project in place (its path is printed); a failed run
 * always does.
 */
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const exampleDir = path.resolve(import.meta.dirname, "..");
const coreDir = path.resolve(exampleDir, "../../packages/core");
const createCli = path.resolve(exampleDir, "../../packages/create/index.ts");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const separator = args.indexOf("--");
const playwrightArgs = separator === -1 ? [] : args.slice(separator + 1);

const work = realpathSync(
  mkdtempSync(path.join(tmpdir(), "openworkspace-notes-"))
);

const project = path.join(work, "notes-example");

function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  console.log(`\n$ ${command.join(" ")}  (in ${cwd})`);

  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });

  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with ${result.exitCode}`);
  }
}

let failed = false;

try {
  // core as published: only its package.json `files`, resolved through its `exports`.
  run(["bun", "pm", "pack", "--destination", work, "--quiet"], coreDir);

  const tarball = new Bun.Glob("open-workspace-core-*.tgz")
    .scanSync({ cwd: work, absolute: true })
    .next().value;

  if (!tarball) throw new Error("bun pm pack wrote no tarball");

  const skip = new Set(["node_modules", ".alchemy", "test-results"]);
  cpSync(exampleDir, project, {
    recursive: true,
    filter: (source) =>
      !skip.has(path.basename(source)) &&
      path.basename(source) !== "outside-monorepo.ts",
  });

  const manifest = JSON.parse(
    readFileSync(path.join(project, "package.json"), "utf-8")
  );

  manifest.dependencies["@open-workspace/core"] = `file:${tarball}`;
  writeFileSync(
    path.join(project, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  run(["bun", "install"], project);
  // The scaffold, as `bunx @open-workspace/create module tasks` runs it: the
  // module it writes installs, gets its first migration, and typechecks.
  run(["bun", createCli, "module", "tasks"], project);
  run(["bun", "install"], project);
  run(["bun", "run", "db:generate:tasks"], project);
  run(["bunx", "tsc", "-p", "modules/tasks"], project);
  run(["bun", "run", "typecheck"], project);
  // Bun runs Playwright: Node refuses to strip types from core's .ts files under node_modules.
  run(["bun", "run", "test:e2e", ...playwrightArgs], project);
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  if (failed || keep) console.log(`\nThe project is in ${project}`);
  else rmSync(work, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
