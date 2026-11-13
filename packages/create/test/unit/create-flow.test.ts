import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { versions } from "../../templates.ts";
import { create, world } from "../create-harness.ts";

const ACME = { id: "a".repeat(32), name: "Acme" };
const LABS = { id: "b".repeat(32), name: "Acme Labs" };

const acmeZones = [
  { id: "zone-com", name: "acme.com", status: "active" },
  { id: "zone-org", name: "acme.org", status: "active" },
];

const google = [
  { name: "acme.com", content: "aspmx.l.google.com", priority: 1 },
];

function read(cwd: string, file: string) {
  return readFileSync(join(cwd, "acme-workspace", file), "utf-8");
}

describe("bun create @open-workspace", () => {
  test("with a saved login and flags, writes the project and deploys without asking", async () => {
    const state = world({
      profiles: new Map([
        ["default", { token: "tok", accountId: ACME.id, method: "oauth" }],
      ]),
      accounts: [ACME, LABS],
      zones: { [ACME.id]: acmeZones },
    });

    const run = await create(
      [
        "acme-workspace",
        "--yes",
        "--account",
        "Acme",
        "--mail-domains",
        "acme.org,acme.com",
      ],
      [],
      state
    );

    expect(run.exitCode).toBe(0);
    expect(state.calls).toEqual(["bun install", "deploy default"]);

    const alchemyRun = read(run.cwd, "alchemy.run.ts");

    expect(alchemyRun).toContain('hostname: "mail.acme.org"');
    expect(alchemyRun).toContain('mailDomains: ["acme.org","acme.com"]');
    expect(alchemyRun).toContain('provider: "cloudflare"');
    expect(read(run.cwd, ".env")).not.toContain("ALCHEMY_PROFILE");
    expect(read(run.cwd, "README.md")).toContain(
      `It deploys to the Cloudflare account Acme (\`${ACME.id}\`), signed in as Alchemy\nprofile \`default\`.`
    );
    expect(run.transcript).toContain(
      "Open https://mail.acme.org and create the first administrator"
    );
  });

  test("signs in when there's no login, and asks for the account, domains and hostname", async () => {
    const state = world({
      // Alchemy's picker saved the first account; the person deploys to the other.
      nextLogin: { token: "fresh", accountId: ACME.id, method: "oauth" },
      accounts: [ACME, LABS],
      zones: { [LABS.id]: acmeZones },
      mx: { "zone-com": google },
    });

    const run = await create(
      [],
      [
        { prompt: "Project name", answer: "acme-workspace" },
        { prompt: "Cloudflare account to deploy to", answer: "Acme Labs" },
        { prompt: "Mail domains", answer: ["acme.com", "acme.org"] },
        { prompt: "Primary mail domain", answer: "acme.org" },
        { prompt: "What next?", answer: "Choose other mail domains" },
        { prompt: "Mail domains", answer: ["acme.org"] },
        { prompt: "Hostname the app is served on", answer: "app.acme.org" },
        { prompt: "AI for spam filtering", answer: "OpenAI" },
        { prompt: "OPENAI_API_KEY", answer: "sk-test" },
        { prompt: "Deploy to Acme Labs now?", answer: true },
      ],
      state
    );

    expect(run.exitCode).toBe(0);
    expect(state.calls).toEqual([
      "bun install",
      "profile edit --profile default --add Cloudflare",
      `set-account default ${LABS.id}`,
      "deploy default",
    ]);
    expect(state.profiles.get("default")?.accountId).toBe(LABS.id);
    expect(run.transcript).toContain("acme.com  MX 1 aspmx.l.google.com");
    expect(read(run.cwd, "alchemy.run.ts")).toContain(
      'hostname: "app.acme.org"'
    );
    expect(read(run.cwd, ".env")).toContain("OPENAI_API_KEY=sk-test");
  });

  test("keeps a saved profile on its account and signs in to the chosen one in a new profile", async () => {
    const state = world({
      profiles: new Map([
        ["default", { token: "old", accountId: ACME.id, method: "oauth" }],
      ]),
      nextLogin: { token: "new", accountId: ACME.id, method: "oauth" },
      accounts: [ACME, LABS],
      zones: { [LABS.id]: acmeZones.slice(0, 1) },
    });

    const run = await create(
      ["acme-workspace"],
      [
        { prompt: "Project name", answer: "acme-workspace" },
        { prompt: "Cloudflare account to deploy to", answer: "Acme Labs" },
        { prompt: "in a new profile, 'acme-workspace'", answer: true },
        { prompt: "Hostname the app is served on", answer: true },
        { prompt: "AI for spam filtering", answer: "None" },
        { prompt: "Deploy to Acme Labs now?", answer: false },
      ],
      state
    );

    expect(run.exitCode).toBe(0);
    expect(state.calls).toEqual([
      "bun install",
      "profile create acme-workspace",
      "profile edit --profile acme-workspace --add Cloudflare",
      `set-account acme-workspace ${LABS.id}`,
    ]);
    expect(state.profiles.get("default")?.accountId).toBe(ACME.id);
    expect(read(run.cwd, ".env")).toContain("ALCHEMY_PROFILE=acme-workspace");
    expect(read(run.cwd, "alchemy.run.ts")).toContain(
      'hostname: "mail.acme.com"'
    );
    expect(run.transcript).toContain(
      "◇  Deploy when you're ready\n│  cd acme-workspace\n│  bun run deploy"
    );
  });

  test("uses another saved profile that already deploys to the chosen account", async () => {
    const state = world({
      profiles: new Map([
        ["default", { token: "old", accountId: ACME.id, method: "oauth" }],
        ["labs", { token: "labs", accountId: LABS.id, method: "stored" }],
      ]),
      accounts: [ACME, LABS],
      zones: { [LABS.id]: acmeZones },
    });

    const run = await create(
      [
        "acme-workspace",
        "--account",
        LABS.id,
        "--mail-domains",
        "acme.com",
        "--ai",
        "none",
        "--no-deploy",
      ],
      [
        { prompt: "Project name", answer: "acme-workspace" },
        { prompt: "Hostname the app is served on", answer: true },
      ],
      state,
      { interactive: true }
    );

    expect(run.exitCode).toBe(0);
    expect(state.calls).toEqual(["bun install"]);
    expect(run.transcript).toContain(
      "Using Alchemy profile 'labs', which deploys to Acme Labs."
    );
    expect(read(run.cwd, ".env")).toContain("ALCHEMY_PROFILE=labs");
  });

  test("deploys to CLOUDFLARE_ACCOUNT_ID when environment credentials are set", async () => {
    const state = world({
      environment: { token: "ci", accountId: LABS.id },
      accounts: [ACME, LABS],
      zones: { [LABS.id]: acmeZones },
    });

    const run = await create(
      ["acme-workspace", "--yes", "--mail-domains", "acme.com"],
      [],
      state
    );

    expect(run.exitCode).toBe(0);
    expect(state.calls).toEqual(["bun install", "deploy default"]);
    expect(read(run.cwd, "README.md")).toContain(
      "with the CLOUDFLARE_API_TOKEN and\nCLOUDFLARE_ACCOUNT_ID environment variables"
    );

    const conflicting = await create(
      [
        "acme-workspace",
        "--yes",
        "--account",
        ACME.id,
        "--mail-domains",
        "acme.com",
      ],
      [],
      state
    );

    expect(conflicting.exitCode).toBe(1);
    expect(conflicting.transcript).toContain(
      `CLOUDFLARE_ACCOUNT_ID is set to ${LABS.id}`
    );
  });

  test("without a terminal, stops where a choice is needed and removes the project", async () => {
    const state = world({
      profiles: new Map([
        ["default", { token: "tok", accountId: ACME.id, method: "oauth" }],
      ]),
      accounts: [ACME, LABS],
      zones: { [ACME.id]: acmeZones },
    });

    const run = await create(["acme-workspace", "--yes"], [], state);

    expect(run.exitCode).toBe(1);
    expect(run.transcript).toContain(
      "This login reaches 2 Cloudflare accounts; say which to deploy to with --account."
    );
    expect(run.transcript).toContain(`--account ${LABS.id}   Acme Labs`);
    expect(readdirSync(run.cwd)).toEqual([]);

    const noLogin = await create(["acme-workspace", "--yes"], [], world());

    expect(noLogin.exitCode).toBe(1);
    expect(noLogin.transcript).toContain(
      "Run bun create @open-workspace in a terminal to sign in, or set CLOUDFLARE_API_TOKEN"
    );
  });

  test("without a terminal, writes the project but doesn't deploy over another provider's MX records", async () => {
    const state = world({
      environment: { token: "ci", accountId: ACME.id },
      zones: { [ACME.id]: acmeZones },
      mx: { "zone-com": google },
    });

    const run = await create(
      [
        "acme-workspace",
        "--yes",
        "--mail-domains",
        "acme.com",
        "--hostname",
        "mail.acme.org",
      ],
      [],
      state
    );

    expect(run.exitCode).toBe(0);
    expect(state.calls).toEqual(["bun install"]);
    expect(run.transcript).toContain(
      "◇  Before deploying\n│  Remove the other mail provider's MX records from the mail domains."
    );
    expect(existsSync(join(run.cwd, "acme-workspace", "alchemy.run.ts"))).toBe(
      true
    );
  });

  test("rejects a hostname outside the account's zones, and domains that aren't zones", async () => {
    const state = world({
      environment: { token: "ci", accountId: ACME.id },
      zones: { [ACME.id]: acmeZones },
    });

    const hostname = await create(
      [
        "acme-workspace",
        "--yes",
        "--mail-domains",
        "acme.com",
        "--hostname",
        "mail.example.com",
      ],
      [],
      state
    );

    expect(hostname.exitCode).toBe(1);
    expect(hostname.transcript).toContain(
      "--hostname: mail.example.com isn't in a zone of this account (acme.com, acme.org)"
    );

    const domains = await create(
      ["acme-workspace", "--yes", "--mail-domains", "acme.com,example.com"],
      [],
      state
    );

    expect(domains.exitCode).toBe(1);
    expect(domains.transcript).toContain(
      "example.com isn't a zone in this account."
    );
  });

  test("a failed deploy keeps the project and prints the command to retry", async () => {
    const state = world({
      environment: { token: "ci", accountId: ACME.id },
      zones: { [ACME.id]: acmeZones },
      deployResult: false,
    });

    const run = await create(
      ["acme-workspace", "--yes", "--mail-domains", "acme.com"],
      [],
      state
    );

    expect(run.exitCode).toBe(1);
    expect(run.transcript).toContain(
      "◇  Fix it, then deploy again\n│  cd acme-workspace\n│  bun run deploy"
    );
    expect(existsSync(join(run.cwd, "acme-workspace", "alchemy.run.ts"))).toBe(
      true
    );
  });

  test("cancelling a prompt removes the project", async () => {
    const state = world({
      profiles: new Map([
        ["default", { token: "tok", accountId: ACME.id, method: "oauth" }],
      ]),
      zones: { [ACME.id]: acmeZones },
    });

    const run = await create(
      ["acme-workspace"],
      [
        { prompt: "Project name", answer: "acme-workspace" },
        { prompt: "Mail domains", answer: "cancel" },
      ],
      state
    );

    expect(run.exitCode).toBe(1);
    expect(run.transcript).toContain("└  Nothing was created.");
    expect(readdirSync(run.cwd)).toEqual([]);
  });
});

describe("the generated project", () => {
  test("is a deployable Alchemy project for the answers", async () => {
    const state = world({
      environment: { token: "ci", accountId: ACME.id },
      zones: { [ACME.id]: acmeZones },
    });

    const run = await create(
      [
        "acme-workspace",
        "--yes",
        "--mail-domains",
        "acme.com,acme.org",
        "--ai",
        "anthropic",
        "--no-deploy",
      ],
      [],
      state,
      { env: { ANTHROPIC_API_KEY: "sk-ant-test" } }
    );

    expect(run.exitCode).toBe(0);
    expect(readdirSync(join(run.cwd, "acme-workspace")).sort()).toEqual([
      ".env",
      ".gitignore",
      "README.md",
      "alchemy.run.ts",
      "package.json",
      "tsconfig.json",
    ]);

    const manifest = z
      .object({
        name: z.string(),
        scripts: z.record(z.string(), z.string()),
        devDependencies: z.record(z.string(), z.string()),
      })
      .parse(JSON.parse(read(run.cwd, "package.json")));

    expect(manifest.name).toBe("acme-workspace");
    expect(manifest.scripts.deploy).toBe("alchemy deploy");
    expect(manifest.devDependencies.alchemy).toBe(versions.alchemy);
    expect(manifest.devDependencies["@alchemy.run/cloudflare"]).toBe(
      versions.alchemy
    );

    const source = read(run.cwd, "alchemy.run.ts");
    const transpiler = new Bun.Transpiler({ loader: "ts" });

    expect(
      transpiler
        .scanImports(source)
        .map((entry) => entry.path)
        .sort()
    ).toEqual([
      "@alchemy.run/cloudflare",
      "@open-workspace/core/alchemy",
      "@open-workspace/email/alchemy",
      "alchemy",
    ]);
    expect(() => transpiler.transformSync(source)).not.toThrow();
    expect(source).toContain('hostname: "mail.acme.com"');
    expect(source).toContain('mailDomains: ["acme.com","acme.org"]');
    expect(source).toContain('apiKeyEnv: "ANTHROPIC_API_KEY"');
    expect(source).toContain("state: Cloudflare.state()");

    expect(read(run.cwd, ".env")).toContain("ANTHROPIC_API_KEY=sk-ant-test");
    expect(run.transcript).toContain(
      "Using ANTHROPIC_API_KEY from the environment."
    );
  });
});
