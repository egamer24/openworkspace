import { describe, expect, test } from "bun:test";

import { parseCreateArgs } from "../../setup/args.ts";

function options(args: string[]) {
  const parsed = parseCreateArgs(args);

  if ("error" in parsed) throw new Error(parsed.error);

  return parsed.options;
}

function error(args: string[]) {
  const parsed = parseCreateArgs(args);

  return "error" in parsed ? parsed.error : undefined;
}

describe("create arguments", () => {
  test("default to asking everything and deploying", () => {
    expect(options([])).toEqual({
      name: undefined,
      account: undefined,
      profile: undefined,
      mailDomains: undefined,
      hostname: undefined,
      ai: undefined,
      deploy: true,
      git: true,
      yes: false,
      help: false,
    });
  });

  test("read every flag for a scripted run", () => {
    expect(
      options([
        "acme-workspace",
        "--account",
        "Acme",
        "--profile=acme",
        "--mail-domains",
        "Acme.com, acme.org",
        "--hostname",
        "Mail.Acme.com",
        "--ai",
        "Anthropic",
        "--no-deploy",
        "--no-git",
        "-y",
      ])
    ).toEqual({
      name: "acme-workspace",
      account: "Acme",
      profile: "acme",
      mailDomains: ["acme.com", "acme.org"],
      hostname: "mail.acme.com",
      ai: "anthropic",
      deploy: false,
      git: false,
      yes: true,
      help: false,
    });
  });

  test("take the name after the flags too", () => {
    expect(options(["--yes", "acme"]).name).toBe("acme");
    expect(options(["-h"]).help).toBe(true);
  });

  test("reject what can't be used", () => {
    expect(error(["--ai", "gemini"])).toBe(
      "--ai must be one of cloudflare, openai, anthropic, none"
    );
    expect(error(["--mail-domains", " , "])).toBe(
      "--mail-domains needs at least one domain"
    );
    expect(error(["one", "two"])).toBe(
      "Expected one project name, got one two"
    );
    expect(error(["--deploy"])).toContain("Unknown option '--deploy'");
    expect(error(["--account"])).toContain("argument missing");
  });
});
