// Alchemy as the new project sees it. Every command runs in the project's
// directory with the project's installed `alchemy` and
// `@alchemy.run/cloudflare`, so signing in, reading the login and deploying
// all use the same version, the same `~/.alchemy` profiles and the same rules
// for picking credentials.
import { join } from "node:path";

import type { z } from "zod";

import {
  credentialsReplySchema,
  profilesReplySchema,
  setAccountReplySchema,
} from "./alchemy-protocol.ts";
import type {
  CredentialsReply,
  ProfilesReply,
  SetAccountReply,
} from "./alchemy-protocol.ts";

export type ProjectAlchemy = {
  /** The Cloudflare credentials a deploy would use (environment variables, else the profile). */
  credentials(): Promise<CredentialsReply>;
  /** Every Alchemy profile, with the Cloudflare account each deploys to. */
  profiles(): Promise<ProfilesReply>;
  /** Points the profile's Cloudflare login at another account it reaches. */
  setAccount(accountId: string): Promise<SetAccountReply>;
  /** `alchemy profile create <name>`. */
  createProfile(name: string): Promise<boolean>;
  /** `alchemy profile edit --add|--reconfigure Cloudflare`: Alchemy's own sign-in, on this terminal. */
  signIn(mode: "add" | "reconfigure"): Promise<boolean>;
  /** `bun run deploy`, its output on this terminal. */
  deploy(): Promise<boolean>;
};

const HELPER = join(import.meta.dirname, "alchemy-helper.ts");

/**
 * Claude Code's variables make Alchemy's CLI treat any terminal as an agent's
 * and refuse to prompt. When a person is at this terminal (create itself is
 * prompting them), the children get it without them.
 */
const AGENT_VARIABLES = new Set(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]);

export function childEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: { profile: string | undefined; interactive: boolean }
) {
  const child: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;

    if (options.interactive && AGENT_VARIABLES.has(key)) continue;

    child[key] = value;
  }

  if (options.profile) child.ALCHEMY_PROFILE = options.profile;

  return child;
}

/** The helper's reply: the last line of its output that parses. */
export function parseReply<T>(output: string, schema: z.ZodType<T>) {
  const lines = output.trim().split("\n").reverse();

  for (const line of lines) {
    try {
      const parsed = schema.safeParse(JSON.parse(line));

      if (parsed.success) return parsed.data;
    } catch {
      // Not the JSON reply: Alchemy may log a line first.
    }
  }

  return undefined;
}

export function projectAlchemy(
  directory: string,
  options: {
    profile: string | undefined;
    interactive: boolean;
    env?: Readonly<Record<string, string | undefined>>;
  }
): ProjectAlchemy {
  const env = childEnv(options.env ?? process.env, options);

  async function helper<T extends { status: string }>(
    args: string[],
    schema: z.ZodType<T>,
    invalid: (message: string) => T
  ) {
    const child = Bun.spawn([process.execPath, HELPER, ...args], {
      cwd: directory,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [output, errors, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return (
      parseReply(output, schema) ??
      invalid(
        `Alchemy exited with code ${exitCode}${errors.trim() ? `: ${errors.trim()}` : ""}`
      )
    );
  }

  /** Runs a command on this terminal: Alchemy prompts and prints straight to the person. */
  async function onTerminal(command: string[]) {
    const child = Bun.spawn(command, {
      cwd: directory,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    return (await child.exited) === 0;
  }

  const profileFlag = options.profile ? ["--profile", options.profile] : [];

  return {
    credentials: () =>
      helper(["credentials"], credentialsReplySchema, (message) => ({
        status: "invalid",
        message,
      })),
    profiles: () =>
      helper(["profiles"], profilesReplySchema, (message) => ({
        status: "invalid",
        message,
      })),
    setAccount: (accountId) =>
      helper(["set-account", accountId], setAccountReplySchema, (message) => ({
        status: "invalid",
        message,
      })),
    createProfile: (name) =>
      onTerminal([process.execPath, "alchemy", "profile", "create", name]),
    signIn: (mode) =>
      onTerminal([
        process.execPath,
        "alchemy",
        "profile",
        "edit",
        ...profileFlag,
        `--${mode}`,
        "Cloudflare",
      ]),
    deploy: () => onTerminal([process.execPath, "run", "deploy", "--yes"]),
  };
}
