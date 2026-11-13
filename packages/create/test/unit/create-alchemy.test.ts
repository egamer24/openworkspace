// The helper on this package's own Alchemy (a dev dependency, the version
// projects install), against a temporary ALCHEMY_HOME: no real profile, no
// network. Stored API-token logins resolve without calling Cloudflare.
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { childEnv, parseReply, projectAlchemy } from "../../setup/alchemy.ts";
import { versions } from "../../templates.ts";

const packageDir = join(import.meta.dirname, "../..");

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

function alchemyHome(profiles: Record<string, string | undefined>) {
  const home = mkdtempSync(join(tmpdir(), "create-alchemy-home-"));

  for (const [name, accountId] of Object.entries(profiles)) {
    mkdirSync(join(home, "profiles", name), { recursive: true });

    if (accountId) {
      writeFileSync(
        join(home, "profiles", name, "cloudflare.json"),
        JSON.stringify({
          format: "alchemy.profile/v1",
          provider: "Cloudflare",
          metadata: {},
          values: {
            method: "stored",
            credentialType: "apiToken",
            apiToken: `token-for-${name}`,
            accountId,
          },
        })
      );
    }
  }

  return home;
}

function alchemy(
  home: string,
  profile?: string,
  extra: Record<string, string> = {}
) {
  return projectAlchemy(packageDir, {
    profile,
    interactive: false,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ALCHEMY_HOME: home,
      ...extra,
    },
  });
}

describe("the project's Alchemy", () => {
  test("is the version projects install", () => {
    const installed = z
      .object({ version: z.string() })
      .parse(
        JSON.parse(
          readFileSync(
            join(packageDir, "node_modules/alchemy/package.json"),
            "utf-8"
          )
        )
      );

    expect(installed.version).toBe(versions.alchemy);
  });

  test("reports a profile without a Cloudflare login as missing", async () => {
    const home = alchemyHome({ default: undefined });

    expect(await alchemy(home).credentials()).toEqual({
      status: "missing",
      message: "Provider 'Cloudflare' is not configured in profile 'default'.",
    });
  });

  test("reads the login a deploy would use, from the selected profile", async () => {
    const home = alchemyHome({ default: ACCOUNT, work: OTHER });

    expect(await alchemy(home).credentials()).toEqual({
      status: "ok",
      source: "profile",
      profile: "default",
      method: "stored",
      accountId: ACCOUNT,
      auth: { type: "token", token: "token-for-default" },
    });

    expect(await alchemy(home, "work").credentials()).toMatchObject({
      profile: "work",
      accountId: OTHER,
    });

    expect(
      await alchemy(home, undefined, { ALCHEMY_PROFILE: "work" }).credentials()
    ).toMatchObject({ profile: "work", accountId: OTHER });
  });

  test("prefers CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, as a deploy does", async () => {
    const home = alchemyHome({ default: ACCOUNT });

    expect(
      await alchemy(home, undefined, {
        CLOUDFLARE_API_TOKEN: "from-env",
        CLOUDFLARE_ACCOUNT_ID: OTHER,
      }).credentials()
    ).toMatchObject({
      status: "ok",
      source: "environment",
      accountId: OTHER,
      auth: { type: "token", token: "from-env" },
    });
  });

  test("reports a profile that doesn't exist as unusable", async () => {
    const home = alchemyHome({ default: undefined });
    const reply = await alchemy(home, "nope").credentials();

    expect(reply.status).toBe("invalid");
  });

  test("lists profiles and the account each deploys to", async () => {
    const home = alchemyHome({ default: undefined, work: OTHER });

    expect(await alchemy(home).profiles()).toEqual({
      status: "ok",
      active: "default",
      profiles: [
        { name: "default" },
        { name: "work", cloudflare: { method: "stored", accountId: OTHER } },
      ],
    });
  });

  test("points a profile's login at another account, keeping the credentials", async () => {
    const home = alchemyHome({ work: ACCOUNT });
    const work = alchemy(home, "work");

    expect(await work.setAccount(OTHER.toUpperCase())).toEqual({
      status: "ok",
      profile: "work",
      accountId: OTHER,
    });

    const file = join(home, "profiles/work/cloudflare.json");

    expect(JSON.parse(readFileSync(file, "utf-8")).values).toEqual({
      method: "stored",
      credentialType: "apiToken",
      apiToken: "token-for-work",
      accountId: OTHER,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    expect(await work.setAccount("not-an-account")).toMatchObject({
      status: "invalid",
    });
    expect(await alchemy(home, "default").setAccount(OTHER)).toMatchObject({
      status: "missing",
    });
  });
});

describe("child processes", () => {
  test("run without Claude Code's variables when a person is at the terminal", () => {
    const env = {
      PATH: "/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      ALCHEMY_PROFILE: "shell",
    };

    expect(childEnv(env, { profile: "acme", interactive: true })).toEqual({
      PATH: "/bin",
      ALCHEMY_PROFILE: "acme",
    });
    expect(childEnv(env, { profile: undefined, interactive: false })).toEqual(
      env
    );
  });

  test("reply with the last line of output that parses", () => {
    const schema = z.object({ status: z.literal("ok") });

    expect(parseReply('log line\n{"status":"ok"}\n', schema)).toEqual({
      status: "ok",
    });
    expect(parseReply('{"status":"no"}\nnot json', schema)).toBeUndefined();
  });
});
