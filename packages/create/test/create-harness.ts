// Drives `runCreate` without a terminal, Alchemy or Cloudflare: a scripted
// Ui that answers prompts in order and records what a person would see, an
// in-memory Alchemy, and a mock of the Cloudflare API behind the real client.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CredentialsReply } from "../setup/alchemy-protocol.ts";
import type { ProjectAlchemy } from "../setup/alchemy.ts";
import { parseCreateArgs } from "../setup/args.ts";
import type { CreateOptions } from "../setup/args.ts";
import { cloudflareApi } from "../setup/cloudflare-api.ts";
import type { Account, MxRecord, Zone } from "../setup/domains.ts";
import { runCreate } from "../setup/flow.ts";
import { Cancelled } from "../setup/ui.ts";
import type { Choice, Ui } from "../setup/ui.ts";

/**
 * A prompt's scripted answer: the message it expects, and the answer. A text
 * prompt takes its initial value for `true`; `"cancel"` cancels any prompt.
 */
export type Answer = {
  prompt: string;
  answer: string | string[] | boolean;
};

export class ScriptedUi implements Ui {
  readonly transcript: string[] = [];
  private readonly answers: Answer[];

  constructor(answers: Answer[]) {
    this.answers = [...answers];
  }

  /** Answers left over: a test should use them all. */
  get unused() {
    return this.answers;
  }

  private next(message: string) {
    const answer = this.answers.shift();

    if (!answer) throw new Error(`Unexpected prompt: ${message}`);

    if (!message.includes(answer.prompt)) {
      throw new Error(`Expected prompt "${answer.prompt}", got "${message}"`);
    }

    if (answer.answer === "cancel") {
      this.transcript.push(`■  ${message}`);
      throw new Cancelled();
    }

    return answer.answer;
  }

  private answered(message: string, shown: string) {
    this.transcript.push(`◇  ${message}`, `│  ${shown}`, "│");
  }

  intro(title: string) {
    this.transcript.push(`┌  ${title}`, "│");
  }

  outro(message: string) {
    this.transcript.push(`└  ${message}`);
  }

  cancel(message: string) {
    this.transcript.push(`└  ${message}`);
  }

  text(prompt: {
    message: string;
    initialValue?: string;
    validate?: (value: string) => string | undefined;
  }) {
    const answer = this.next(prompt.message);

    const value =
      answer === true ? (prompt.initialValue ?? "") : String(answer);

    const problem = prompt.validate?.(value);

    if (problem) throw new Error(`"${value}" failed validation: ${problem}`);

    this.answered(prompt.message, value);

    return Promise.resolve(value);
  }

  password(prompt: { message: string }) {
    const value = String(this.next(prompt.message));

    this.answered(prompt.message, "▪".repeat(value.length));

    return Promise.resolve(value);
  }

  confirm(prompt: { message: string; initialValue?: boolean }) {
    const value = this.next(prompt.message) === true;

    this.answered(prompt.message, value ? "Yes" : "No");

    return Promise.resolve(value);
  }

  select<T extends string>(prompt: {
    message: string;
    options: Choice<T>[];
    initialValue?: T;
  }) {
    const answer = this.next(prompt.message);

    const chosen =
      prompt.options.find((option) => option.label === answer) ??
      prompt.options.find((option) => option.value === prompt.initialValue);

    if (!chosen) {
      throw new Error(`No option "${String(answer)}" in "${prompt.message}"`);
    }

    this.answered(prompt.message, chosen.label);

    return Promise.resolve(chosen.value);
  }

  multiselect<T extends string>(prompt: {
    message: string;
    options: Choice<T>[];
    initialValues?: T[];
  }) {
    const answer = this.next(prompt.message);
    const labels = Array.isArray(answer) ? answer : [];

    const chosen = prompt.options.filter((option) =>
      labels.includes(option.label)
    );

    this.answered(
      prompt.message,
      chosen.map((option) => option.label).join(", ")
    );

    return Promise.resolve(chosen.map((option) => option.value));
  }

  info(message: string) {
    this.log("●", message);
  }

  success(message: string) {
    this.log("◆", message);
  }

  warn(message: string) {
    this.log("▲", message);
  }

  error(message: string) {
    this.log("■", message);
  }

  step(message: string) {
    this.log("◇", message);
  }

  note(message: string, title: string) {
    this.transcript.push(
      `◇  ${title}`,
      ...message.split("\n").map((line) => `│  ${line}`),
      "│"
    );
  }

  async progress<T>(
    _message: string,
    work: () => Promise<T>,
    done: (result: T) => string
  ) {
    const result = await work();

    this.transcript.push(`◇  ${done(result)}`, "│");

    return result;
  }

  private log(symbol: string, message: string) {
    const [first, ...rest] = message.split("\n");

    this.transcript.push(
      `${symbol}  ${first ?? ""}`,
      ...rest.map((line) => `│  ${line}`),
      "│"
    );
  }
}

/** One Cloudflare login, as Alchemy would store it in a profile. */
export type Login = { token: string; accountId: string; method: string };

/** What the fake Alchemy and the mock API share: profiles, and what each token reaches. */
export type World = {
  profiles: Map<string, Login | undefined>;
  activeProfile: string;
  /** CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID, when set. */
  environment?: { token: string; accountId: string };
  /** The login `alchemy profile edit` saves, as if a person signed in. */
  nextLogin?: Login;
  accounts: Account[];
  zones: Record<string, Zone[]>;
  mx: Record<string, MxRecord[]>;
  deployResult: boolean;
  calls: string[];
};

export function world(overrides: Partial<World> = {}): World {
  return {
    profiles: new Map([["default", undefined]]),
    activeProfile: "default",
    accounts: [{ id: "a".repeat(32), name: "Acme" }],
    zones: {},
    mx: {},
    deployResult: true,
    calls: [],
    ...overrides,
  };
}

function fakeAlchemy(
  state: World,
  profile: string | undefined
): ProjectAlchemy {
  const name = profile ?? state.activeProfile;

  const credentials = (): CredentialsReply => {
    if (state.environment) {
      return {
        status: "ok",
        source: "environment",
        profile: name,
        method: "environment",
        accountId: state.environment.accountId,
        auth: { type: "token", token: state.environment.token },
      };
    }

    if (!state.profiles.has(name)) {
      return {
        status: "invalid",
        message: `Profile '${name}' does not exist.`,
      };
    }

    const login = state.profiles.get(name);

    if (!login) {
      return {
        status: "missing",
        message: `Provider 'Cloudflare' is not configured in profile '${name}'.`,
      };
    }

    return {
      status: "ok",
      source: "profile",
      profile: name,
      method: login.method,
      accountId: login.accountId,
      auth: { type: "token", token: login.token },
    };
  };

  return {
    credentials: () => Promise.resolve(credentials()),
    profiles: () =>
      Promise.resolve({
        status: "ok",
        active: state.activeProfile,
        profiles: [...state.profiles].map(([entry, login]) => ({
          name: entry,
          cloudflare: login
            ? { method: login.method, accountId: login.accountId }
            : undefined,
        })),
      }),
    setAccount(accountId) {
      state.calls.push(`set-account ${name} ${accountId}`);

      const login = state.profiles.get(name);

      if (!login) {
        return Promise.resolve({ status: "missing", message: "no login" });
      }

      state.profiles.set(name, { ...login, accountId });

      return Promise.resolve({ status: "ok", profile: name, accountId });
    },
    createProfile(created) {
      state.calls.push(`profile create ${created}`);
      state.profiles.set(created, undefined);

      return Promise.resolve(true);
    },
    signIn(mode) {
      state.calls.push(`profile edit --profile ${name} --${mode} Cloudflare`);

      if (!state.nextLogin) return Promise.resolve(false);

      state.profiles.set(name, state.nextLogin);

      return Promise.resolve(true);
    },
    deploy() {
      state.calls.push(`deploy ${name}`);

      return Promise.resolve(state.deployResult);
    },
  };
}

type Envelope = {
  success: boolean;
  errors: { code: number; message: string }[];
  result:
    | readonly (
        | Account
        | Zone
        | MxRecord
        | { status: string; account: Account }
      )[]
    | null;
  result_info?: { page: number; total_pages: number };
};

function json(body: Envelope, status = 200) {
  return Promise.resolve(Response.json(body, { status }));
}

/** The Cloudflare API endpoints create reads, over the world's accounts, zones and records. */
export function mockFetch(state: World) {
  const tokens = () => [
    ...[...state.profiles.values()].flatMap((login) =>
      login ? [login.token] : []
    ),
    ...(state.environment ? [state.environment.token] : []),
  ];

  return (url: string, init: RequestInit) => {
    const authorization = new Headers(init.headers).get("Authorization") ?? "";

    if (!tokens().some((token) => authorization === `Bearer ${token}`)) {
      return json(
        {
          success: false,
          errors: [{ code: 10_000, message: "Authentication error" }],
          result: null,
        },
        403
      );
    }

    const { pathname, searchParams } = new URL(url);

    const ok = (result: Envelope["result"]) =>
      json({
        success: true,
        errors: [],
        result,
        result_info: { page: 1, total_pages: 1 },
      });

    if (pathname.endsWith("/memberships")) {
      return ok(
        state.accounts.map((account) => ({ status: "accepted", account }))
      );
    }

    const records = /\/zones\/([^/]+)\/dns_records$/u.exec(pathname);

    if (records?.[1]) {
      const zone = decodeURIComponent(records[1]);

      if (
        !(zone in state.mx) &&
        Object.values(state.zones)
          .flat()
          .every((entry) => entry.id !== zone)
      ) {
        return json(
          {
            success: false,
            errors: [{ code: 7003, message: "No route" }],
            result: null,
          },
          404
        );
      }

      return ok(
        (state.mx[zone] ?? []).map((record) => ({ ...record, type: "MX" }))
      );
    }

    if (pathname.endsWith("/zones")) {
      return ok(state.zones[searchParams.get("account.id") ?? ""] ?? []);
    }

    return json(
      {
        success: false,
        errors: [{ code: 7000, message: `No route for ${pathname}` }],
        result: null,
      },
      404
    );
  };
}

/** Runs create with these arguments and answers; the project is made in a fresh directory. */
export async function create(
  args: string[],
  answers: Answer[],
  state: World,
  options: { interactive?: boolean; env?: Record<string, string> } = {}
) {
  const parsed = parseCreateArgs(args);

  if ("error" in parsed) throw new Error(parsed.error);

  const createOptions: CreateOptions = parsed.options;
  const cwd = mkdtempSync(join(tmpdir(), "create-flow-"));
  const ui = new ScriptedUi(answers);
  const fetchImpl = mockFetch(state);

  const exitCode = await runCreate(createOptions, {
    ui,
    cwd,
    env: options.env ?? {},
    interactive: options.interactive ?? !createOptions.yes,
    install: () => {
      state.calls.push("bun install");

      return Promise.resolve({ ok: true, output: "" });
    },
    alchemy: (_directory, profile) => fakeAlchemy(state, profile),
    cloudflare: (auth) => cloudflareApi(auth, fetchImpl),
    git: () => Promise.resolve("committed"),
  });

  return { exitCode, cwd, ui, transcript: ui.transcript.join("\n") };
}
