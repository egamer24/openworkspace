#!/usr/bin/env bun
// `bun create @open-workspace` writes a new project; `… module <name>` adds a
// module to one; `… import` brings people and mail into a deployed workspace.
if (process.argv[2] === "module") {
  const { main } = await import("./module.ts");
  process.exitCode = main(process.argv.slice(3));
} else if (process.argv[2] === "import") {
  const { main } = await import("./import/cli.ts");
  process.exitCode = await main(process.argv.slice(3));
} else {
  const { main } = await import("./create.ts");
  process.exitCode = await main(process.argv.slice(2));
}

// oxlint-disable-next-line unicorn/require-module-specifiers -- marks the bin script as a module for top-level await
export {};
