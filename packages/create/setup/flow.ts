// `bun create @open-workspace`: writes and installs the project, signs in to
// Cloudflare with the project's Alchemy, picks the account, the mail domains
// and the hostname from what that login can see, and deploys.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  alchemyRunTs,
  envFile,
  gitignore,
  packageJson,
  readme,
  tsconfigJson,
} from "../templates.ts";
import type { ProjectAnswers } from "../templates.ts";
import type { CredentialsReply, CloudflareAuth } from "./alchemy-protocol.ts";
import type { ProjectAlchemy } from "./alchemy.ts";
import type { AiChoice, CreateOptions } from "./args.ts";
import { CloudflareApiError } from "./cloudflare-api.ts";
import type { CloudflareApi } from "./cloudflare-api.ts";
import {
  describeMx,
  findAccount,
  foreignMx,
  hostnameProblem,
  primaryFirst,
  suggestedHostname,
  zonesNamed,
} from "./domains.ts";
import type { Account, MxRecord, Zone } from "./domains.ts";
import { Cancelled } from "./ui.ts";
import type { Ui } from "./ui.ts";

export type CreateDeps = {
  ui: Ui;
  /** Where the project's directory is made. */
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Whether a person answers prompts. Without one, nothing is asked. */
  interactive: boolean;
  install(directory: string): Promise<{ ok: boolean; output: string }>;
  alchemy(directory: string, profile: string | undefined): ProjectAlchemy;
  cloudflare(auth: CloudflareAuth): CloudflareApi;
  /**
   * Starts a git repository in the new project with everything as its first
   * commit: "committed", "initialized" (no commit, e.g. git has no identity
   * set), or "skipped" (no git, or the directory is already in a repository).
   */
  git(directory: string): Promise<"committed" | "initialized" | "skipped">;
};

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;

const DEFAULT_PROFILE = "default";

/** Ends the run with a message, and what to do about it. */
class Stop extends Error {
  constructor(
    message: string,
    readonly next?: string
  ) {
    super(message);
  }
}

type SignedIn = Extract<CredentialsReply, { status: "ok" }>;

type Connection = {
  alchemy: ProjectAlchemy;
  credentials: SignedIn;
  accounts: Account[];
  /** Whether the profile was signed in by this run (so its account is this run's to set). */
  signedInNow: boolean;
};

/** Runs create; resolves to the exit code. */
export async function runCreate(options: CreateOptions, deps: CreateDeps) {
  const { ui } = deps;

  let project:
    | { directory: string; created: boolean; written: boolean }
    | undefined;

  ui.intro("OpenWorkspace");

  try {
    const name = await projectName(options, deps);
    const directory = resolve(deps.cwd, name);

    if (existsSync(directory) && readdirSync(directory).length > 0) {
      throw new Stop(`${directory} is not empty.`);
    }

    project = { directory, created: !existsSync(directory), written: false };

    await install(name, directory, deps);

    const connection = await connect(directory, options, deps);

    const { account, alchemy, credentials } = await bindAccount(
      connection,
      name,
      directory,
      options,
      deps
    );

    const zones = await ui.progress(
      `Listing the zones in ${account.name}`,
      async () =>
        (await deps.cloudflare(credentials.auth).zones(account.id)).sort(
          (a, b) => a.name.localeCompare(b.name)
        ),
      (found) =>
        `${found.length} ${found.length === 1 ? "zone" : "zones"} in ${account.name}`
    );

    if (zones.length === 0) {
      throw new Stop(
        `${account.name} has no zones. Mail domains and the app's hostname must be zones in it.`,
        `Add your domain at https://dash.cloudflare.com/${account.id}/add-site, then run bun create @open-workspace again.`
      );
    }

    const api = deps.cloudflare(credentials.auth);

    const mail = await chooseMailDomains(
      zones,
      api,
      options.mailDomains,
      [],
      deps
    );

    const hostname = await chooseHostname(
      mail.domains[0] ?? "",
      zones,
      options,
      deps
    );

    const ai = await chooseAi(options, deps);

    const pinnedProfile =
      credentials.source === "profile" &&
      credentials.profile !== DEFAULT_PROFILE
        ? credentials.profile
        : undefined;

    const answers: ProjectAnswers = {
      name,
      hostname,
      mailDomains: mail.domains,
      ai: ai.choice,
      cloudflare: {
        account,
        profile:
          credentials.source === "profile" ? credentials.profile : undefined,
      },
    };

    writeProject(directory, answers, ai.key, pinnedProfile);
    project.written = true;
    ui.success(`Wrote ${name}/alchemy.run.ts and ${name}/.env`);

    if (options.git) {
      const repository = await deps.git(directory);

      if (repository === "committed") {
        ui.success(
          "Started a git repository with the project as its first commit"
        );
      } else if (repository === "initialized") {
        ui.info(
          "Started a git repository; commit the project when git knows who you are"
        );
      }
    }

    return await deploy(
      { name, hostname, account, primary: mail.domains[0] ?? "", alchemy },
      {
        mxBlocked: mail.mxBlocked,
        missingKey: ai.key && !ai.key.value ? ai.key.name : undefined,
      },
      options,
      deps
    );
  } catch (failure) {
    if (project && !project.written) discard(project);

    if (failure instanceof Cancelled) {
      ui.cancel(project?.written ? "Stopped." : "Nothing was created.");

      return 1;
    }

    if (failure instanceof Stop) {
      ui.error(failure.message);

      if (failure.next) ui.info(failure.next);

      ui.cancel(project?.written ? "Stopped." : "Nothing was created.");

      return 1;
    }

    throw failure;
  }
}

/** Removes what this run put in the project's directory, before the project was complete. */
function discard(project: { directory: string; created: boolean }) {
  if (project.created) {
    rmSync(project.directory, { recursive: true, force: true });

    return;
  }

  for (const entry of readdirSync(project.directory)) {
    rmSync(join(project.directory, entry), { recursive: true, force: true });
  }
}

function projectName(options: CreateOptions, deps: CreateDeps) {
  if (options.name !== undefined) {
    if (!NAME.test(options.name)) {
      throw new Stop(
        `"${options.name}" can't be the project name: use lowercase letters, digits, and dashes.`
      );
    }

    if (!deps.interactive) return options.name;
  }

  if (!deps.interactive) {
    throw new Stop(
      "The project name is missing.",
      "Pass it first: bun create @open-workspace acme-workspace --yes"
    );
  }

  return deps.ui.text({
    message: "Project name",
    placeholder: "acme-workspace",
    initialValue: options.name ?? "",
    validate: (value) =>
      NAME.test(value)
        ? undefined
        : "Use lowercase letters, digits, and dashes",
  });
}

/** Writes package.json and installs it: signing in uses the project's own Alchemy. */
async function install(name: string, directory: string, deps: CreateDeps) {
  const answers = { name, hostname: "", mailDomains: [], ai: "none" as const };

  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), packageJson(answers));
  writeFileSync(join(directory, "tsconfig.json"), tsconfigJson);
  writeFileSync(join(directory, ".gitignore"), gitignore);

  const result = await deps.ui.progress(
    "Installing dependencies with bun",
    () => deps.install(directory),
    (installed) =>
      installed.ok ? "Dependencies installed" : "bun install failed"
  );

  if (!result.ok) {
    throw new Stop(
      `bun install failed:\n${result.output.trim()}`,
      "Fix the problem above, then run bun create @open-workspace again."
    );
  }
}

function describeLogin(credentials: SignedIn) {
  return credentials.source === "environment"
    ? "Signed in to Cloudflare with CLOUDFLARE_API_TOKEN"
    : `Signed in to Cloudflare (Alchemy profile '${credentials.profile}')`;
}

/** The Cloudflare login a deploy will use, signing in first when there's none, and the accounts it reaches. */
async function connect(
  directory: string,
  options: CreateOptions,
  deps: CreateDeps
): Promise<Connection> {
  const { ui } = deps;
  const alchemy = deps.alchemy(directory, options.profile);

  const found = await ui.progress(
    "Checking for a Cloudflare login",
    () => alchemy.credentials(),
    (reply) =>
      reply.status === "ok" ? describeLogin(reply) : "No Cloudflare login yet"
  );

  if (found.status === "ok") {
    try {
      return {
        alchemy,
        credentials: found,
        accounts: await listAccounts(found, deps),
        signedInNow: false,
      };
    } catch (failure) {
      const rejected =
        failure instanceof CloudflareApiError &&
        (failure.status === 401 || failure.status === 403);

      if (!rejected || found.source === "environment" || !deps.interactive) {
        throw failure;
      }

      ui.warn(`Cloudflare rejected the saved login: ${failure.message}`);
    }
  } else if (found.status === "invalid") {
    ui.warn(found.message);
  }

  if (!deps.interactive) {
    throw new Stop(
      found.status === "ok"
        ? "Cloudflare rejected the saved login."
        : `There's no usable Cloudflare login: ${found.message}`,
      "Run bun create @open-workspace in a terminal to sign in, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, then run this again."
    );
  }

  const credentials = await signIn(alchemy, options.profile, deps);

  return {
    alchemy,
    credentials,
    accounts: await listAccounts(credentials, deps),
    signedInNow: true,
  };
}

/** Alchemy's own sign-in (`alchemy profile edit`), on this terminal, then the login it saved. */
async function signIn(
  alchemy: ProjectAlchemy,
  profile: string | undefined,
  deps: CreateDeps
) {
  const { ui } = deps;
  const listed = await alchemy.profiles();

  const name =
    profile ?? (listed.status === "ok" ? listed.active : DEFAULT_PROFILE);

  const existing =
    listed.status === "ok"
      ? listed.profiles.find((entry) => entry.name === name)
      : undefined;

  if (
    !existing &&
    name !== DEFAULT_PROFILE &&
    !(await alchemy.createProfile(name))
  ) {
    throw new Stop(`Couldn't create the Alchemy profile '${name}'.`);
  }

  ui.step(
    [
      `Signing in to Cloudflare with Alchemy (profile '${name}').`,
      "Choose OAuth and All Scopes: the deploy sets up Workers, D1, R2, DNS and Email Routing.",
    ].join("\n")
  );

  const finished = await alchemy.signIn(
    existing?.cloudflare ? "reconfigure" : "add"
  );

  const credentials = await alchemy.credentials();

  if (!finished || credentials.status !== "ok") {
    throw new Stop(
      `Signing in to Cloudflare didn't finish${credentials.status === "ok" ? "" : `: ${credentials.message}`}`,
      `Run bun create @open-workspace again, or sign in yourself with \`bun alchemy profile edit --add Cloudflare\`.`
    );
  }

  ui.success(describeLogin(credentials));

  return credentials;
}

async function listAccounts(credentials: SignedIn, deps: CreateDeps) {
  const accounts = await deps.ui.progress(
    "Listing the Cloudflare accounts this login reaches",
    () => deps.cloudflare(credentials.auth).accounts(),
    (found) =>
      `${found.length} Cloudflare ${found.length === 1 ? "account" : "accounts"}`
  );

  if (accounts.length === 0) {
    throw new Stop(
      "This login reaches no Cloudflare account.",
      "Sign in again with `bun alchemy profile edit --reconfigure Cloudflare` and choose All Scopes."
    );
  }

  return accounts;
}

/** Which account to deploy to: always asked when the login reaches several. */
async function chooseAccount(
  connection: Connection,
  options: CreateOptions,
  deps: CreateDeps
) {
  const { accounts, credentials } = connection;

  const current = accounts.find(
    (account) => account.id === credentials.accountId
  );

  if (credentials.source === "environment") {
    const account = current ?? {
      id: credentials.accountId,
      name: credentials.accountId,
    };

    const wanted = options.account && findAccount([account], options.account);

    if (options.account && !wanted) {
      throw new Stop(
        `CLOUDFLARE_ACCOUNT_ID is set to ${credentials.accountId}, and the deploy uses it, not --account ${options.account}.`
      );
    }

    return account;
  }

  if (options.account) {
    const account = findAccount(accounts, options.account);

    if (!account) {
      throw new Stop(
        `This login can't reach a Cloudflare account "${options.account}".`,
        `It reaches: ${accounts.map((entry) => `${entry.name} (${entry.id})`).join(", ")}`
      );
    }

    return account;
  }

  const [only] = accounts;

  if (accounts.length === 1 && only) return only;

  if (!deps.interactive) {
    throw new Stop(
      `This login reaches ${accounts.length} Cloudflare accounts; say which to deploy to with --account.`,
      accounts
        .map((entry) => `--account ${entry.id}   ${entry.name}`)
        .join("\n")
    );
  }

  const id = await deps.ui.select({
    message: "Cloudflare account to deploy to",
    options: accounts.map((account) => ({
      value: account.id,
      label: account.name,
      hint:
        account.id === credentials.accountId
          ? `${account.id}, the profile's account`
          : account.id,
    })),
    initialValue: current?.id,
  });

  return accounts.find((account) => account.id === id) ?? accounts[0];
}

/**
 * Makes sure the deploy goes to the chosen account. Alchemy deploys to the
 * account stored in the profile, so the profile must hold it: a profile this
 * run signed in is pointed at it; a profile other projects may already deploy
 * with is left alone, and another profile on that account is used, or a new
 * one, named after the project, is signed in.
 */
async function bindAccount(
  connection: Connection,
  name: string,
  directory: string,
  options: CreateOptions,
  deps: CreateDeps
): Promise<{
  account: Account;
  alchemy: ProjectAlchemy;
  credentials: SignedIn;
}> {
  const { ui } = deps;
  const account = await chooseAccount(connection, options, deps);
  const { alchemy, credentials } = connection;

  if (account?.id === undefined) throw new Stop("No account was chosen.");

  if (account.id === credentials.accountId) {
    return { account, alchemy, credentials };
  }

  if (connection.signedInNow) {
    return {
      account,
      alchemy,
      credentials: await pointAt(alchemy, account, deps),
    };
  }

  const other = await profileOn(account, connection, directory, deps);

  if (other) {
    ui.info(
      `Using Alchemy profile '${other.credentials.profile}', which deploys to ${account.name}.`
    );

    return { account, ...other };
  }

  const current =
    connection.accounts.find((entry) => entry.id === credentials.accountId)
      ?.name ?? credentials.accountId;

  if (!deps.interactive) {
    throw new Stop(
      `Alchemy profile '${credentials.profile}' deploys to ${current}, not ${account.name}.`,
      `Pass --profile with a profile signed in to ${account.name}, or sign one in: bun alchemy profile create ${name} && bun alchemy profile edit --profile ${name} --add Cloudflare`
    );
  }

  const fresh = await uniqueProfileName(name, connection.alchemy);

  const proceed = await ui.confirm({
    message: `Alchemy profile '${credentials.profile}' deploys to ${current}, and other projects may rely on that. Sign in to ${account.name} in a new profile, '${fresh}', for this project?`,
    initialValue: true,
  });

  // Declined: choose the account again.
  if (!proceed) return bindAccount(connection, name, directory, options, deps);

  const alchemyForProject = deps.alchemy(directory, fresh);
  const signedIn = await signIn(alchemyForProject, fresh, deps);

  return {
    account,
    alchemy: alchemyForProject,
    credentials:
      signedIn.accountId === account.id
        ? signedIn
        : await pointAt(alchemyForProject, account, deps),
  };
}

/** Points a profile this run signed in at the chosen account. */
async function pointAt(
  alchemy: ProjectAlchemy,
  account: Account,
  deps: CreateDeps
) {
  const set = await alchemy.setAccount(account.id);
  const credentials = await alchemy.credentials();

  if (set.status !== "ok" || credentials.status !== "ok") {
    throw new Stop(
      `Couldn't point the Alchemy profile at ${account.name}: ${set.status === "ok" ? "" : set.message}`
    );
  }

  deps.ui.success(
    `Alchemy profile '${set.profile}' now deploys to ${account.name}.`
  );

  return credentials;
}

/** Another profile that already deploys to the account, if one does and its login still works. */
async function profileOn(
  account: Account,
  connection: Connection,
  directory: string,
  deps: CreateDeps
) {
  const listed = await connection.alchemy.profiles();

  if (listed.status !== "ok") return undefined;

  const candidates = listed.profiles.filter(
    (profile) =>
      profile.name !== connection.credentials.profile &&
      profile.cloudflare?.accountId === account.id
  );

  const checked = await Promise.all(
    candidates.map(async (candidate) => {
      const alchemy = deps.alchemy(directory, candidate.name);

      return { alchemy, credentials: await alchemy.credentials() };
    })
  );

  for (const { alchemy, credentials } of checked) {
    if (credentials.status === "ok" && credentials.accountId === account.id) {
      return { alchemy, credentials };
    }
  }

  return undefined;
}

async function uniqueProfileName(name: string, alchemy: ProjectAlchemy) {
  const listed = await alchemy.profiles();

  const taken = new Set(
    listed.status === "ok" ? listed.profiles.map((profile) => profile.name) : []
  );

  let candidate = name;

  for (let index = 2; taken.has(candidate); index++) {
    candidate = `${name}-${index}`;
  }

  return candidate;
}

/** Mail domains, primary first, chosen from the account's zones; warns about another provider's MX records. */
async function chooseMailDomains(
  zones: Zone[],
  api: CloudflareApi,
  requested: string[] | undefined,
  previous: string[],
  deps: CreateDeps
): Promise<{ domains: string[]; mxBlocked: boolean }> {
  const chosen = await pickMailZones(zones, requested, previous, deps);
  const outcome = await settleMx(chosen, zones.length > 1, api, deps);

  if (outcome === "back") {
    return chooseMailDomains(
      zones,
      api,
      undefined,
      chosen.map((zone) => zone.name),
      deps
    );
  }

  return {
    domains: chosen.map((zone) => zone.name),
    mxBlocked: outcome === "blocked",
  };
}

/** Checks the zones for another provider's MX records until there are none, or the person moves on. */
async function settleMx(
  chosen: Zone[],
  canGoBack: boolean,
  api: CloudflareApi,
  deps: CreateDeps
): Promise<"clear" | "blocked" | "back"> {
  const { ui } = deps;
  const verdict = await checkMx(chosen, api, deps);

  if (verdict.length === 0) return "clear";

  ui.warn(
    [
      "Another mail provider's MX records are in:",
      ...verdict.flatMap((entry) => describeMx(entry.records)),
      "",
      "Email Routing adds Cloudflare's own MX records and can't start while these",
      "are there, so the deploy would fail. Remove them under DNS → Records in the",
      "Cloudflare dashboard (mail stops reaching the old provider), or leave the",
      "domain out for now.",
    ].join("\n")
  );

  if (!deps.interactive) return "blocked";

  const next = await ui.select({
    message: "What next?",
    options: [
      { value: "recheck", label: "I removed them: check again" },
      ...(canGoBack
        ? [{ value: "back", label: "Choose other mail domains" }]
        : []),
      {
        value: "continue",
        label: "Keep these domains",
        hint: "deploy after removing the records",
      },
    ],
  });

  if (next === "recheck") return settleMx(chosen, canGoBack, api, deps);

  return next === "back" ? "back" : "blocked";
}

async function pickMailZones(
  zones: Zone[],
  requested: string[] | undefined,
  previous: string[],
  deps: CreateDeps
) {
  const { ui } = deps;

  if (requested) {
    const { found, missing } = zonesNamed(requested, zones);

    if (missing.length === 0) return found;

    const problem = `${missing.join(", ")} ${missing.length === 1 ? "isn't a zone" : "aren't zones"} in this account. Zones: ${zones.map((zone) => zone.name).join(", ")}`;

    if (!deps.interactive) throw new Stop(problem);

    ui.warn(problem);
  }

  const [only] = zones;

  if (zones.length === 1 && only && !requested && previous.length === 0) {
    ui.info(`Mail domain: ${only.name}, the account's only zone.`);

    return [only];
  }

  if (!deps.interactive) {
    throw new Stop(
      "Say which zones are mail domains with --mail-domains, primary first.",
      `Zones: ${zones.map((zone) => zone.name).join(", ")}`
    );
  }

  const ids = await ui.multiselect({
    message: "Mail domains (space to select, enter to confirm)",
    options: zones.map((zone) => ({
      value: zone.id,
      label: zone.name,
      hint: zone.status === "active" ? undefined : zone.status,
    })),
    initialValues: zonesNamed(requested ?? previous, zones).found.map(
      (zone) => zone.id
    ),
  });

  const chosen = zones.filter((zone) => ids.includes(zone.id));
  const [first] = chosen;

  if (chosen.length < 2 || !first) return chosen;

  const primaryId = await ui.select({
    message: "Primary mail domain (the first administrator's address is on it)",
    options: chosen.map((zone) => ({ value: zone.id, label: zone.name })),
    initialValue: first.id,
  });

  const primary = chosen.find((zone) => zone.id === primaryId) ?? first;

  return primaryFirst(
    chosen.map((zone) => zone.name),
    primary.name
  ).flatMap((domain) => chosen.filter((zone) => zone.name === domain));
}

/** Zones whose MX records point at another provider. A zone whose records can't be read is reported, not blocked. */
async function checkMx(zones: Zone[], api: CloudflareApi, deps: CreateDeps) {
  const results = await deps.ui.progress(
    "Checking the mail domains' MX records",
    () =>
      Promise.all(
        zones.map(async (zone) => {
          try {
            return { zone, records: foreignMx(await api.mxRecords(zone.id)) };
          } catch (failure) {
            return {
              zone,
              records: [] satisfies MxRecord[],
              unreadable:
                failure instanceof Error ? failure.message : String(failure),
            };
          }
        })
      ),
    (checked) =>
      checked.some((entry) => entry.records.length > 0)
        ? "Found another mail provider's MX records"
        : "No other mail provider's MX records"
  );

  for (const entry of results) {
    if (entry.unreadable) {
      deps.ui.warn(
        `Couldn't read ${entry.zone.name}'s DNS records (${entry.unreadable}). Check that it has no other provider's MX records before deploying.`
      );
    }
  }

  return results.filter((entry) => entry.records.length > 0);
}

async function chooseHostname(
  primary: string,
  zones: Zone[],
  options: CreateOptions,
  deps: CreateDeps
) {
  const suggested = options.hostname ?? suggestedHostname(primary);
  const problem = hostnameProblem(suggested, zones);

  if (!deps.interactive) {
    if (problem) throw new Stop(`--hostname: ${problem}`);

    return suggested;
  }

  if (options.hostname && !problem) return options.hostname;

  if (options.hostname && problem) deps.ui.warn(`--hostname: ${problem}`);

  const hostname = await deps.ui.text({
    message: "Hostname the app is served on",
    initialValue: suggested,
    validate: (value) => hostnameProblem(value, zones),
  });

  return hostname.trim().toLowerCase();
}

const AI_KEYS = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
} as const;

async function chooseAi(options: CreateOptions, deps: CreateDeps) {
  const { ui } = deps;

  const choice: AiChoice =
    options.ai ??
    (deps.interactive
      ? await ui.select<AiChoice>({
          message: "AI for spam filtering, folders, and translation",
          options: [
            {
              value: "cloudflare",
              label: "Cloudflare AI Gateway",
              hint: "no key; uses your account's AI credits",
            },
            { value: "openai", label: "OpenAI", hint: "needs an API key" },
            {
              value: "anthropic",
              label: "Anthropic",
              hint: "needs an API key",
            },
            { value: "none", label: "None" },
          ],
        })
      : "cloudflare");

  if (choice !== "openai" && choice !== "anthropic") {
    return { choice, key: undefined };
  }

  const name = AI_KEYS[choice];
  const fromEnv = deps.env[name];

  if (fromEnv) {
    ui.info(`Using ${name} from the environment.`);

    return { choice, key: { name, value: fromEnv } };
  }

  const value = deps.interactive
    ? await ui.password({
        message: `${name} (stored in .env; the deploy needs it, so leave it empty only to add it there later)`,
      })
    : "";

  return { choice, key: { name, value } };
}

function writeProject(
  directory: string,
  answers: ProjectAnswers,
  aiKey: { name: string; value: string } | undefined,
  alchemyProfile: string | undefined
) {
  const files = {
    "package.json": packageJson(answers),
    "alchemy.run.ts": alchemyRunTs(answers),
    "tsconfig.json": tsconfigJson,
    ".gitignore": gitignore,
    "README.md": readme(answers),
    ".env": envFile({ aiKey, alchemyProfile }),
  } satisfies Record<string, string>;

  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(directory, file), content);
  }
}

async function deploy(
  target: {
    name: string;
    hostname: string;
    account: Account;
    primary: string;
    alchemy: ProjectAlchemy;
  },
  blockers: { mxBlocked: boolean; missingKey: string | undefined },
  options: CreateOptions,
  deps: CreateDeps
) {
  const { ui } = deps;
  const retry = `cd ${target.name}\nbun run deploy`;
  const url = `https://${target.hostname}`;
  const firstAdmin = `create the first administrator with a passkey, on an address at ${target.primary}`;

  const before = [
    ...(blockers.mxBlocked
      ? ["Remove the other mail provider's MX records from the mail domains."]
      : []),
    ...(blockers.missingKey ? [`Add ${blockers.missingKey} to .env.`] : []),
  ];

  const migrating = () =>
    ui.note(
      "bunx @open-workspace/create import --help   # bring people and mail over from Google Workspace, IMAP or mbox",
      "Migrating?"
    );

  if (!options.deploy || before.length > 0) {
    ui.note(
      [...before, ...(before.length > 0 ? [""] : []), retry].join("\n"),
      before.length > 0 ? "Before deploying" : "Deploy when you're ready"
    );
    migrating();
    ui.outro(`Then open ${url} and ${firstAdmin}.`);

    return 0;
  }

  const now =
    !deps.interactive ||
    (await ui.confirm({
      message: `Deploy to ${target.account.name} now?`,
      initialValue: true,
    }));

  if (!now) {
    ui.note(retry, "Deploy when you're ready");
    migrating();
    ui.outro(`Then open ${url} and ${firstAdmin}.`);

    return 0;
  }

  ui.step(
    "Deploying with Alchemy (bun run deploy). The first deploy takes a few minutes."
  );

  if (!(await target.alchemy.deploy())) {
    ui.error("The deploy failed; Alchemy printed why above.");
    ui.note(retry, "Fix it, then deploy again");
    ui.outro(`Then open ${url} and ${firstAdmin}.`);

    return 1;
  }

  ui.success(`Deployed to ${target.account.name}.`);
  migrating();
  ui.outro(`Open ${url} and ${firstAdmin}.`);

  return 0;
}
