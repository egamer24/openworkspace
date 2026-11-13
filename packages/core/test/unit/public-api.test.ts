import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { required } from "../../shared/invariant.ts";

/**
 * Core's public surface is its package.json `exports`. Modules (email, the
 * examples, a deployment's own) import only those; everything else in core
 * may change between releases.
 */

const coreDir = path.resolve(import.meta.dirname, "../..");
const repoDir = path.resolve(coreDir, "../..");

const exportsMap = z
  .object({ exports: z.record(z.string(), z.string()) })
  .parse(
    JSON.parse(readFileSync(path.join(coreDir, "package.json"), "utf-8"))
  ).exports;

const publicSpecifiers = new Set(
  Object.keys(exportsMap).map((key) =>
    path.posix.join("@open-workspace/core", key)
  )
);

const skipped = new Set([
  "node_modules",
  ".alchemy",
  "dist",
  "test-results",
  ".git",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (skipped.has(entry.name)) return [];
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) return sourceFiles(full);

    return /\.(?:[cm]?tsx?|[cm]?jsx?)$/u.test(entry.name) ? [full] : [];
  });
}

/** Specifiers of static imports and exports, dynamic imports, and `import type`s. */
function specifiers(source: string) {
  const found: string[] = [];

  for (const match of source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/gu
  )) {
    found.push(required(match[1], "the specifier group always matches"));
  }

  return found;
}

function offenders(files: string[], allowed: (specifier: string) => boolean) {
  return files.flatMap((file) =>
    specifiers(readFileSync(file, "utf-8"))
      .filter((specifier) => !allowed(specifier))
      .map((specifier) => `${path.relative(repoDir, file)}: ${specifier}`)
  );
}

describe("core's public API", () => {
  test("every entry point exists", () => {
    for (const target of Object.values(exportsMap)) {
      expect(() => readFileSync(path.join(coreDir, target))).not.toThrow();
    }
  });

  test("code outside core imports only core's entry points", () => {
    const roots = ["packages", "apps", "examples"].map((dir) =>
      path.join(repoDir, dir)
    );

    const files = roots
      .flatMap((root) => {
        try {
          return sourceFiles(root);
        } catch {
          return [];
        }
      })
      .filter((file) => !file.startsWith(coreDir + path.sep));

    expect(files.length).toBeGreaterThan(0);

    const deep = offenders(
      files,
      (specifier) =>
        !specifier.startsWith("@open-workspace/core") ||
        publicSpecifiers.has(specifier)
    );

    expect(deep).toEqual([]);
  });

  test("core's own code uses relative imports, which resolve wherever it is installed", () => {
    // A path alias such as "@/…" resolves only with core's tsconfig and Vite
    // config, not when a deployment's TypeScript follows an entry into core.
    const files = [
      "src",
      "worker",
      "shared",
      "alchemy",
      "dev",
      "testing",
    ].flatMap((dir) => sourceFiles(path.join(coreDir, dir)));

    const aliased = offenders(
      files,
      (specifier) =>
        !specifier.startsWith("@/") &&
        !specifier.startsWith("@open-workspace/core/")
    );

    expect(aliased).toEqual([]);
  });
});
