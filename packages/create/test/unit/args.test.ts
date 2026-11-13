import { describe, expect, it } from "bun:test";

import { joinDashValues, parseCliArgs } from "../../import/args.ts";
import { commonOptions } from "../../import/cli.ts";

describe("import arguments", () => {
  it("reads a value that starts with a dash", () => {
    const { values } = parseCliArgs({
      args: ["--workspace", "https://example.test", "--token", "-abc_123"],
      options: commonOptions,
    });

    expect(values.token).toBe("-abc_123");
    expect(values.workspace).toBe("https://example.test");
  });

  it("keeps the --name=value form", () => {
    const { values } = parseCliArgs({
      args: ["--token=-abc"],
      options: commonOptions,
    });

    expect(values.token).toBe("-abc");
  });

  it("still rejects a missing value followed by another option", () => {
    expect(() =>
      parseCliArgs({ args: ["--token", "--login"], options: commonOptions })
    ).toThrow("ambiguous");
    expect(() =>
      parseCliArgs({ args: ["--token", "-h"], options: commonOptions })
    ).toThrow("ambiguous");
  });

  it("joins only string options, and nothing after --", () => {
    expect(
      joinDashValues(
        ["--dry-run", "-x", "--token", "-a", "--", "--token", "-b"],
        commonOptions
      )
    ).toEqual(["--dry-run", "-x", "--token=-a", "--", "--token", "-b"]);
  });
});
