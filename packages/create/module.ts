import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  moduleFiles,
  moduleNames,
  wireAlchemyRun,
  wiringLines,
  withModuleDependencies,
} from "./module-templates";

/**
 * `bunx @open-workspace/create module <name>`, run in a deployment project:
 * writes `modules/<name>/` and wires it into `alchemy.run.ts`. Returns the
 * exit code.
 */
export function main(
  args: string[],
  cwd = process.cwd(),
  log = console.log
): number {
  const [name] = args;

  if (!name || args.length > 1) {
    log(
      "Usage: bunx @open-workspace/create module <name>   (e.g. time-off), in your deployment's directory"
    );

    return 1;
  }

  let names;

  try {
    names = moduleNames(name);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));

    return 1;
  }

  const project = resolve(cwd);
  const dir = join(project, "modules", name);

  if (existsSync(dir)) {
    log(`${dir} already exists; nothing was written.`);

    return 1;
  }

  for (const [path, content] of Object.entries(moduleFiles(names))) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), content);
  }

  mkdirSync(join(dir, "migrations"), { recursive: true });
  log(`Wrote modules/${name}/`);

  const manifest = join(project, "package.json");

  if (existsSync(manifest)) {
    writeFileSync(
      manifest,
      withModuleDependencies(readFileSync(manifest, "utf-8"), names)
    );
    log(
      `Added its dependencies and the db:generate:${name} script to package.json`
    );
  }

  const alchemyRun = join(project, "alchemy.run.ts");

  const wired = existsSync(alchemyRun)
    ? wireAlchemyRun(readFileSync(alchemyRun, "utf-8"), names)
    : null;

  if (wired === null) {
    const { importLine, entry } = wiringLines(names);
    log(
      [
        "",
        "alchemy.run.ts was left as it is. Add the module to it:",
        `  ${importLine}`,
        `  OpenWorkspace({ …, modules: [/* … */, ${entry}] })`,
      ].join("\n")
    );
  } else {
    writeFileSync(alchemyRun, wired);
    log(`Listed ${names.pascal}() in alchemy.run.ts`);
  }

  log(
    [
      "",
      "Next:",
      "  bun install",
      `  bun run db:generate:${name}   # its first migration, from modules/${name}/worker/schema.ts`,
      "  bun run deploy",
      "",
      "See docs/modules.md in the OpenWorkspace repository for the contract and the public API.",
    ].join("\n")
  );

  return 0;
}
