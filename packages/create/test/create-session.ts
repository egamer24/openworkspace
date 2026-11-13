#!/usr/bin/env bun
/**
 * Runs `bun create @open-workspace` on this terminal against a mock of the
 * Cloudflare API, to see the session as a person would. Alchemy is real (this
 * package's, linked into the project instead of installed) and reads a
 * throwaway ALCHEMY_HOME holding a stored API-token login, so nothing reaches
 * Cloudflare or your own profiles. Deploying runs nothing: it only says so.
 *
 *   bun test/create-session.ts [create arguments]
 *
 * With SESSION_SIGNED_OUT=1 the home starts without a login, and signing in
 * saves one as Alchemy's would (to the first account), without a browser.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectAlchemy } from "../setup/alchemy.ts";
import { parseCreateArgs } from "../setup/args.ts";
import { cloudflareApi } from "../setup/cloudflare-api.ts";
import { runCreate } from "../setup/flow.ts";
import { clackUi } from "../setup/ui.ts";
import { mockFetch, world } from "./create-harness.ts";

const ACME = { id: "0123456789abcdef0123456789abcdef", name: "Acme" };
const LABS = { id: "fedcba9876543210fedcba9876543210", name: "Acme Labs" };

const home = mkdtempSync(join(tmpdir(), "create-session-alchemy-"));
const signedOut = process.env.SESSION_SIGNED_OUT === "1";

/** Saves a stored login to the default profile, as `alchemy profile edit` would. */
function saveLogin() {
  mkdirSync(join(home, "profiles/default"), { recursive: true });
  writeFileSync(
    join(home, "profiles/default/cloudflare.json"),
    JSON.stringify({
      format: "alchemy.profile/v1",
      provider: "Cloudflare",
      metadata: {},
      values: {
        method: "stored",
        credentialType: "apiToken",
        apiToken: "mock-token",
        accountId: ACME.id,
      },
    })
  );
}

if (!signedOut) saveLogin();

const state = world({
  profiles: new Map([
    ["default", { token: "mock-token", accountId: ACME.id, method: "stored" }],
  ]),
  accounts: [ACME, LABS],
  zones: {
    [ACME.id]: [
      { id: "zone-com", name: "acme.com", status: "active" },
      { id: "zone-org", name: "acme.org", status: "active" },
      { id: "zone-dev", name: "acme.dev", status: "pending" },
    ],
  },
  mx: {
    "zone-org": [
      { name: "acme.org", content: "aspmx.l.google.com", priority: 1 },
      { name: "acme.org", content: "alt1.aspmx.l.google.com", priority: 5 },
    ],
  },
});

const parsed = parseCreateArgs(process.argv.slice(2));

if ("error" in parsed) throw new Error(parsed.error);

const cwd = mkdtempSync(join(tmpdir(), "create-session-"));
const env = { ...process.env, ALCHEMY_HOME: home };
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

process.chdir(cwd);

process.exitCode = await runCreate(parsed.options, {
  ui: clackUi,
  cwd,
  env,
  interactive: interactive && !parsed.options.yes,
  install(directory) {
    symlinkSync(
      join(import.meta.dirname, "../node_modules"),
      join(directory, "node_modules")
    );

    return Bun.sleep(400).then(() => ({ ok: true, output: "" }));
  },
  alchemy(directory, profile) {
    const real = projectAlchemy(directory, { profile, interactive, env });

    return {
      ...real,
      signIn: () => {
        console.log("│  (session: Alchemy's sign-in would run here)");
        saveLogin();

        return Promise.resolve(true);
      },
      deploy: () => {
        console.log("│  (session: bun run deploy would run here)");

        return Promise.resolve(true);
      },
    };
  },
  cloudflare: (auth) => cloudflareApi(auth, mockFetch(state)),
  git: () => Promise.resolve("committed"),
});
