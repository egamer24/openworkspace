// `bun create @open-workspace [name] [options]`.
import { parseCliArgs } from "../import/args.ts";
import { parseDomainList } from "./domains.ts";

export const AI_CHOICES = [
  "cloudflare",
  "openai",
  "anthropic",
  "none",
] as const;

export type AiChoice = (typeof AI_CHOICES)[number];

export type CreateOptions = {
  name?: string;
  /** Cloudflare account id or name. */
  account?: string;
  /** Alchemy profile to sign in with; defaults to $ALCHEMY_PROFILE, else "default". */
  profile?: string;
  /** Mail domains, primary first. */
  mailDomains?: string[];
  hostname?: string;
  ai?: AiChoice;
  deploy: boolean;
  /** Start a git repository with the project as its first commit. */
  git: boolean;
  /** Ask nothing: take defaults, and stop where a choice is needed. */
  yes: boolean;
  help: boolean;
};

export const createUsage = `Usage: bun create @open-workspace [name] [options]

Writes a project, signs in to Cloudflare with Alchemy, and deploys it.

Options:
  --account <id or name>   Cloudflare account to deploy to
  --profile <name>         Alchemy profile to sign in with
                           (default: $ALCHEMY_PROFILE, else "default")
  --mail-domains <list>    Mail domains, primary first, comma-separated:
                           zones in the account
  --hostname <host>        Where the app is served (default: mail.<primary>)
  --ai <provider>          cloudflare (default), openai, anthropic or none;
                           keys come from OPENAI_API_KEY / ANTHROPIC_API_KEY
  --no-deploy              Write and install the project, but don't deploy
  --no-git                 Don't start a git repository in the project
  -y, --yes                Ask nothing; fail where a choice is needed
  -h, --help               Show this help

Without a terminal, or with --yes, nothing is asked, and signing in
can't happen: it needs a Cloudflare login in your Alchemy profile (from
an earlier run), or CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.`;

const options = {
  account: { type: "string" },
  profile: { type: "string" },
  "mail-domains": { type: "string" },
  hostname: { type: "string" },
  ai: { type: "string" },
  "no-deploy": { type: "boolean" },
  "no-git": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
} as const;

function isAiChoice(value: string): value is AiChoice {
  return AI_CHOICES.some((choice) => choice === value);
}

/** The options, or what's wrong with them. */
export function parseCreateArgs(
  args: readonly string[]
): { options: CreateOptions } | { error: string } {
  let parsed: ReturnType<typeof parse>;

  try {
    parsed = parse(args);
  } catch (failure) {
    return {
      error: failure instanceof Error ? failure.message : String(failure),
    };
  }

  const { values, positionals } = parsed;

  if (positionals.length > 1) {
    return { error: `Expected one project name, got ${positionals.join(" ")}` };
  }

  const ai = values.ai?.toLowerCase();

  if (ai !== undefined && !isAiChoice(ai)) {
    return { error: `--ai must be one of ${AI_CHOICES.join(", ")}` };
  }

  const mailDomains =
    values["mail-domains"] === undefined
      ? undefined
      : parseDomainList(values["mail-domains"]);

  if (mailDomains?.length === 0) {
    return { error: "--mail-domains needs at least one domain" };
  }

  return {
    options: {
      name: positionals[0],
      account: values.account,
      profile: values.profile,
      mailDomains,
      hostname: values.hostname?.trim().toLowerCase(),
      ai,
      deploy: !values["no-deploy"],
      git: !values["no-git"],
      yes: values.yes ?? false,
      help: values.help ?? false,
    },
  };
}

function parse(args: readonly string[]) {
  return parseCliArgs({
    args: [...args],
    options,
    allowPositionals: true,
    strict: true,
  });
}
