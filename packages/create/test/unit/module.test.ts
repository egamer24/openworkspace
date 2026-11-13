import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { required } from "../../import/invariant.ts";
import { main } from "../../module";
import {
  moduleDependencies,
  moduleDevDependencies,
  moduleFiles,
  moduleNames,
  wireAlchemyRun,
  withModuleDependencies,
} from "../../module-templates";
import { alchemyRunTs, packageJson } from "../../templates";

const answers = {
  name: "acme-workspace",
  hostname: "mail.acme.com",
  mailDomains: ["acme.com"],
  ai: "none" as const,
};

function project() {
  const dir = mkdtempSync(path.join(tmpdir(), "create-module-"));
  writeFileSync(path.join(dir, "package.json"), packageJson(answers));
  writeFileSync(path.join(dir, "alchemy.run.ts"), alchemyRunTs(answers));

  return dir;
}

describe("module names", () => {
  test("derive every identifier from the id", () => {
    expect(moduleNames("time-off")).toEqual({
      name: "time-off",
      pascal: "TimeOff",
      camel: "timeOff",
      constant: "TIME_OFF",
      snake: "time_off",
      label: "Time off",
    });
  });

  test("are lowercase words: they also name OAuth scopes and webhook events", () => {
    for (const bad of [
      "Notes",
      "notes2",
      "-notes",
      "notes-",
      "time_off",
      "",
      "a--b",
    ]) {
      expect(() => moduleNames(bad)).toThrow();
    }
  });
});

describe("module files", () => {
  const files = moduleFiles(moduleNames("time-off"));

  test("are the three halves, a schema, and a tsconfig", () => {
    expect(Object.keys(files).sort()).toEqual([
      "modules/time-off/alchemy.ts",
      "modules/time-off/drizzle.config.ts",
      "modules/time-off/index.ts",
      "modules/time-off/shared/module.ts",
      "modules/time-off/src/client.tsx",
      "modules/time-off/src/home.tsx",
      "modules/time-off/tsconfig.json",
      "modules/time-off/worker/mcp.ts",
      "modules/time-off/worker/module.ts",
      "modules/time-off/worker/routes.ts",
      "modules/time-off/worker/schema.ts",
    ]);
  });

  test("import only core's public entry points", () => {
    const entries = new Set([
      "@open-workspace/core/alchemy",
      "@open-workspace/core/module",
      "@open-workspace/core/shared",
      "@open-workspace/core/ui",
    ]);

    for (const content of Object.values(files)) {
      for (const match of content.matchAll(
        /from "(@open-workspace\/[^"]+)"/gu
      )) {
        expect(entries).toContain(match[1]);
      }
    }
  });

  test("use scope and event ids core accepts", () => {
    const shared = required(
      files["modules/time-off/shared/module.ts"],
      "the module's shared/module.ts"
    );

    expect(shared).toContain(`"time_off.read"`);
    expect(shared).toContain(`"time_off.item_created"`);
    expect(shared).toContain(`TIME_OFF_MODULE = "time-off"`);
  });

  test("ask for core's versions of what they import", () => {
    const dependencies = z.record(z.string(), z.string());

    const core = z
      .object({ dependencies, devDependencies: dependencies })
      .parse(
        JSON.parse(
          readFileSync(
            path.resolve(import.meta.dirname, "../../../core/package.json"),
            "utf-8"
          )
        )
      );

    const versions = { ...core.dependencies, ...core.devDependencies };

    for (const [name, version] of Object.entries({
      ...moduleDependencies,
      ...moduleDevDependencies,
    })) {
      expect(`${name}@${versions[name]}`).toBe(`${name}@${version}`);
    }
  });
});

describe("wiring alchemy.run.ts", () => {
  const names = moduleNames("notes");

  test("imports the module and lists it after the others", () => {
    const wired = required(
      wireAlchemyRun(alchemyRunTs(answers), names),
      "alchemy.run.ts wired"
    );

    expect(wired).toContain(
      `import { Email } from "@open-workspace/email/alchemy";\nimport { Notes } from "./modules/notes/alchemy.ts";\n`
    );
    expect(wired).toContain("    modules: [Email(), Notes()],\n");
    expect(wireAlchemyRun(wired, names)).toBe(wired);
  });

  test("fills an empty list", () => {
    const source = `import { OpenWorkspace } from "@open-workspace/core/alchemy";\nOpenWorkspace({\n  modules: [],\n});\n`;
    expect(wireAlchemyRun(source, names)).toContain("  modules: [Notes()],\n");
  });

  test("leaves a file it cannot edit safely to the person", () => {
    const multiline = `import { OpenWorkspace } from "@open-workspace/core/alchemy";\nOpenWorkspace({\n  modules: [\n    Email(),\n  ],\n});\n`;
    expect(wireAlchemyRun(multiline, names)).toBeNull();
    expect(
      wireAlchemyRun(
        `import { OpenWorkspace } from "x";\nOpenWorkspace({ mailDomains: ["a.com"] });\n`,
        names
      )
    ).toBeNull();
  });
});

test("package.json gets the module's dependencies and its migration script, keeping pinned versions", () => {
  const manifest = JSON.parse(
    withModuleDependencies(
      JSON.stringify({ dependencies: { hono: "4.0.0" } }),
      moduleNames("notes")
    )
  );

  expect(manifest.dependencies.hono).toBe("4.0.0");
  expect(manifest.dependencies["drizzle-orm"]).toBe(
    moduleDependencies["drizzle-orm"]
  );
  expect(manifest.devDependencies["drizzle-kit"]).toBe(
    moduleDevDependencies["drizzle-kit"]
  );
  expect(manifest.scripts["db:generate:notes"]).toBe(
    "cd modules/notes && drizzle-kit generate"
  );
});

describe("create module <name>", () => {
  test("writes the module into a project made by `bun create @open-workspace` and wires it", () => {
    const dir = project();
    const output: string[] = [];

    try {
      expect(main(["time-off"], dir, (line) => output.push(line))).toBe(0);
      expect(
        existsSync(path.join(dir, "modules/time-off/worker/routes.ts"))
      ).toBe(true);
      expect(existsSync(path.join(dir, "modules/time-off/migrations"))).toBe(
        true
      );
      expect(readFileSync(path.join(dir, "alchemy.run.ts"), "utf-8")).toContain(
        "modules: [Email(), TimeOff()]"
      );
      expect(
        JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8"))
          .dependencies.hono
      ).toBeDefined();
      expect(output.join("\n")).toContain("bun run db:generate:time-off");

      // Twice is refused, and nothing changes.
      const before = readFileSync(path.join(dir, "alchemy.run.ts"), "utf-8");
      expect(main(["time-off"], dir, () => {})).toBe(1);
      expect(readFileSync(path.join(dir, "alchemy.run.ts"), "utf-8")).toBe(
        before
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prints the lines to add when alchemy.run.ts is not one it can edit", () => {
    const dir = project();
    const output: string[] = [];

    try {
      writeFileSync(path.join(dir, "alchemy.run.ts"), "export default {};\n");
      expect(main(["notes"], dir, (line) => output.push(line))).toBe(0);
      expect(output.join("\n")).toContain(
        `import { Notes } from "./modules/notes/alchemy.ts";`
      );
      expect(readFileSync(path.join(dir, "alchemy.run.ts"), "utf-8")).toBe(
        "export default {};\n"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a bad name or a missing one", () => {
    expect(main([], tmpdir(), () => {})).toBe(1);
    expect(main(["Bad_Name"], tmpdir(), () => {})).toBe(1);
  });
});
