import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startRepository } from "../../create.ts";

// The commit needs a git identity: CI sets one in its workflow.
describe("startRepository", () => {
  test("commits a new project, leaving .env out", async () => {
    const directory = mkdtempSync(join(tmpdir(), "create-git-"));

    writeFileSync(join(directory, ".gitignore"), ".env\n");
    writeFileSync(join(directory, ".env"), "SECRET=1\n");
    writeFileSync(join(directory, "alchemy.run.ts"), "export {};\n");

    expect(await startRepository(directory)).toBe("committed");

    const files = Bun.spawnSync(["git", "ls-files"], { cwd: directory })
      .stdout.toString()
      .trim()
      .split("\n");

    expect(files).toEqual([".gitignore", "alchemy.run.ts"]);
  });

  test("leaves a project inside an existing repository alone", async () => {
    const outer = mkdtempSync(join(tmpdir(), "create-git-outer-"));

    Bun.spawnSync(["git", "init", "--quiet"], { cwd: outer });

    const directory = join(outer, "workspace");

    Bun.spawnSync(["mkdir", directory]);

    expect(await startRepository(directory)).toBe("skipped");
  });
});
