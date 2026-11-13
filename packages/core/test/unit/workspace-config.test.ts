import { describe, expect, it } from "bun:test";

import { workspaceConfigSchema } from "../../worker/config/schema.ts";
import type { WorkspaceConfigInput } from "../../worker/config/schema.ts";

const issues = (input: Partial<WorkspaceConfigInput>) =>
  workspaceConfigSchema.safeParse(input).error?.issues.map((issue) => ({
    path: issue.path,
    message: issue.message,
  }));

describe("workspace configuration", () => {
  it("requires at least one mail domain", () => {
    expect(issues({})).toEqual([
      { path: ["mailDomains"], message: expect.any(String) },
    ]);
    expect(issues({ mailDomains: [] })).toEqual([
      { path: ["mailDomains"], message: "List at least one mail domain" },
    ]);
  });

  it("keeps the mail domains in order, primary first, normalized", () => {
    expect(
      workspaceConfigSchema.parse({
        mailDomains: [" Example.com ", "example.org"],
      }).mailDomains
    ).toEqual(["example.com", "example.org"]);
  });

  it("rejects repeated and malformed mail domains", () => {
    expect(issues({ mailDomains: ["example.com", "EXAMPLE.com"] })).toEqual([
      { path: ["mailDomains"], message: "List each mail domain once" },
    ]);
    expect(
      workspaceConfigSchema.safeParse({ mailDomains: ["not a domain"] }).success
    ).toBe(false);
  });
});
