export type ProjectAnswers = {
  /** Directory and package name, e.g. "acme-workspace"; the Alchemy stack is named after it. */
  name: string;
  /** Hostname the app is served on, e.g. "mail.acme.com". */
  hostname: string;
  /** Mail domains, primary first. */
  mailDomains: string[];
  ai: "none" | "cloudflare" | "openai" | "anthropic";
  /** Where it deploys: the Cloudflare account, and the Alchemy profile signed in to it (none with environment credentials). */
  cloudflare?: {
    account: { id: string; name: string };
    profile: string | undefined;
  };
};

export const versions = {
  openWorkspace: "0.4.1",
  alchemy: "2.0.0-beta.85",
  effect: "4.1.3",
  typescript: "7.0.2",
  nodeTypes: "26.6.6",
  bun: "1.4.4",
};

function stackName(name: string) {
  return (
    name
      .split(/[^a-zA-Z0-9]+/u)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("") || "Workspace"
  );
}

export function packageJson(answers: ProjectAnswers) {
  return `${JSON.stringify(
    {
      name: answers.name,
      private: true,
      type: "module",
      packageManager: `bun@${versions.bun}`,
      scripts: {
        deploy: "alchemy deploy",
        dev: "alchemy dev",
        destroy: "alchemy destroy",
        logs: "alchemy logs --tail",
      },
      dependencies: {
        "@open-workspace/core": versions.openWorkspace,
        "@open-workspace/email": versions.openWorkspace,
      },
      devDependencies: {
        "@alchemy.run/cloudflare": versions.alchemy,
        "@effect/platform-bun": versions.effect,
        "@effect/platform-node": versions.effect,
        "@types/node": versions.nodeTypes,
        alchemy: versions.alchemy,
        effect: versions.effect,
        typescript: versions.typescript,
      },
    },
    null,
    2
  )}\n`;
}

function aiOption(ai: ProjectAnswers["ai"]) {
  switch (ai) {
    case "none": {
      return "";
    }

    case "cloudflare": {
      return `
    // AI runs through AI Gateway, billed to your Cloudflare account's credits.
    ai: {
      providers: { cloudflare: { type: "cloudflare" } },
      features: {
        classification: { enabled: true, provider: "cloudflare", model: "openai/gpt-6-luna", reasoning: "medium" },
        translation: { enabled: true, provider: "cloudflare", model: "openai/gpt-6-luna", reasoning: "none" },
      },
    },`;
    }

    case "openai": {
      return `
    // The key is the OPENAI_API_KEY secret, read from .env when you deploy (required).
    ai: {
      providers: { openai: { type: "openai", apiKeyEnv: "OPENAI_API_KEY" } },
      features: {
        classification: { enabled: true, provider: "openai", model: "gpt-5-mini", reasoning: "low" },
        translation: { enabled: true, provider: "openai", model: "gpt-5-mini", reasoning: "none" },
      },
    },`;
    }

    case "anthropic": {
      return `
    // The key is the ANTHROPIC_API_KEY secret, read from .env when you deploy (required).
    ai: {
      providers: { anthropic: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" } },
      features: {
        classification: { enabled: true, provider: "anthropic", model: "claude-haiku-5-5" },
        translation: { enabled: true, provider: "anthropic", model: "claude-haiku-5-5" },
      },
    },`;
    }

    default: {
      const unexpected: never = ai;
      throw new Error(`Unknown AI choice: ${String(unexpected)}`);
    }
  }
}

export function alchemyRunTs(answers: ProjectAnswers) {
  // The options sit one level deeper here, inside Effect.gen.
  const ai = aiOption(answers.ai).replaceAll("\n", "\n  ");

  return `import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { OpenWorkspace, providers } from "@open-workspace/core/alchemy";
import { Email } from "@open-workspace/email/alchemy";

export default Alchemy.Stack(
  ${JSON.stringify(stackName(answers.name))},
  { providers: providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    // Single sign-on apps can be declared here instead of in the admin UI,
    // SCIM provisioning included (the token is a secret from .env, never a
    // plain string), and passed to OpenWorkspace as apps: [grafana]:
    //   const grafana = yield* OidcClient("Grafana", {
    //     name: "Grafana",
    //     redirectUris: ["https://grafana.example.com/login/generic_oauth"],
    //     access: "everyone",
    //     provisioning: {
    //       baseUrl: "https://grafana.example.com/api/scim/v2",
    //       token: yield* Config.Redacted("GRAFANA_SCIM_TOKEN"),
    //     },
    //   });

    const workspace = yield* OpenWorkspace({
      // Required. Where the app is served: a hostname in a zone of this account.
      // https://<hostname> is the OIDC issuer, the SAML IdP, and where passkeys work.
      hostname: ${JSON.stringify(answers.hostname)},
      // Mail domains, primary first. Every address is on one of them.
      // Email() turns on Email Routing and Email Sending for each.
      mailDomains: ${JSON.stringify(answers.mailDomains)},${ai}
      modules: [Email()],
      // \`bun run dev\` serves the workspace at http://localhost:5173, where
      // passkeys work too; the hostname above is only for the deploy.
      dev: { port: 5173 },
    });

    // \`workspace\` also holds the OIDC and SAML endpoints and certificate, for
    // wiring up other resources such as a Cloudflare Access login method
    // (https://openworkspace.dev/docs/sso). The deploy prints only the URL.
    return { url: workspace.url };
  }),
);
`;
}

export const tsconfigJson = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2023",
      lib: ["ES2023"],
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      types: ["node"],
    },
    include: ["alchemy.run.ts"],
  },
  null,
  2
)}\n`;

export const gitignore = `node_modules
.alchemy
.env
`;

function deployTarget(answers: ProjectAnswers) {
  const { cloudflare } = answers;

  if (!cloudflare) {
    return `
Sign in to Cloudflare once first: \`bun alchemy profile edit --add Cloudflare\`.
`;
  }

  const account = `${cloudflare.account.name} (\`${cloudflare.account.id}\`)`;

  return cloudflare.profile
    ? `
It deploys to the Cloudflare account ${account}, signed in as Alchemy
profile \`${cloudflare.profile}\`${cloudflare.profile === "default" ? "" : " (`ALCHEMY_PROFILE` in `.env`)"}.
If that login expires, run \`bun alchemy profile refresh${cloudflare.profile === "default" ? "" : ` --profile ${cloudflare.profile}`}\`.
`
    : `
It deploys to the Cloudflare account ${account}, with the CLOUDFLARE_API_TOKEN and
CLOUDFLARE_ACCOUNT_ID environment variables.
`;
}

export function readme(answers: ProjectAnswers) {
  return `# ${answers.name}

An [OpenWorkspace](https://openworkspace.dev) deployment on your Cloudflare account.

- \`alchemy.run.ts\` — the workspace (mail domains, AI, and modules) and its Cloudflare
  resources, managed by [Alchemy](https://alchemy.run). The Worker's code comes from the
  packages; Alchemy writes its entry from this file on every deploy.
- \`.env\` — API keys for outside services, uploaded as Worker secrets on deploy. Keep it out of git. The OIDC and SAML signing keys and the push keys are minted by Alchemy on the first deploy and kept in its state.

## Deploy

\`\`\`sh
bun run deploy
\`\`\`
${deployTarget(answers)}
Open https://${answers.hostname} and create the first administrator with a passkey,
using an address on ${answers.mailDomains[0]}.

Alchemy turns on Email Routing for ${answers.mailDomains.join(", ")}, sends every
address to the Worker, onboards the mail domains to Email Sending, and subscribes
the delivery events queue. Email Routing adds the zones' MX and SPF records and
locks them; remove another mail provider's MX records from a zone first, or the
deploy fails.

Profile photos and the workspace logo need no setup: they are kept in an R2
bucket the deploy creates and resized by the Worker's Images binding, without
Cloudflare Images storage or an Images subscription. The first 5,000 unique
transformations a month are free; each photo or logo size counts once a month.

## Develop

\`bun run dev\` runs the workspace at http://localhost:5173 on Cloudflare's local
runtime, with its own local data: create a first administrator there with a
passkey, as on the deployed app. Mail from outside doesn't reach it.

## Update

\`\`\`sh
bun update @open-workspace/core @open-workspace/email
bun run deploy
\`\`\`
`;
}

export function envFile(input: {
  aiKey?: { name: string; value: string };
  /** The Alchemy profile signed in to the chosen Cloudflare account, when it isn't "default". */
  alchemyProfile?: string;
}) {
  return [
    "# Secrets for outside services, uploaded as Worker secrets by `alchemy deploy`.",
    "# Never commit this file. Signing keys need no entry: Alchemy mints them.",
    ...(input.alchemyProfile
      ? [
          "",
          "# The Alchemy profile signed in to this deployment's Cloudflare account.",
          `ALCHEMY_PROFILE=${input.alchemyProfile}`,
        ]
      : []),
    ...(input.aiKey
      ? [
          "",
          input.aiKey.value
            ? `${input.aiKey.name}=${input.aiKey.value}`
            : `# Required to deploy: the AI provider in alchemy.run.ts reads it.\n${input.aiKey.name}=`,
        ]
      : []),
    "",
    "# Optional:",
    "# SPAMHAUS_DQS_KEY=",
    "# SCIM tokens of single sign-on apps declared in alchemy.run.ts, e.g. GRAFANA_SCIM_TOKEN=",
    "",
  ].join("\n");
}
