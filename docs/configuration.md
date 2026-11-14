# Configuration

You configure the workspace in `alchemy.run.ts`, in your project folder. Change
it, then run `bun run deploy`. If a setting is invalid, the deploy stops and
lists what to fix.

```ts
// alchemy.run.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import { OpenWorkspace, providers } from "@open-workspace/core/alchemy";
import { Email } from "@open-workspace/email/alchemy";
import * as Alchemy from "alchemy";

export default Alchemy.Stack(
  "Workspace",
  { providers: providers(), state: Cloudflare.state() },
  OpenWorkspace({
    hostname: "mail.example.com",
    mailDomains: ["example.com", "example.org"],
    ai: {
      providers: {
        cloudflare: { type: "cloudflare" },
        anthropic: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
      },
      features: {
        classification: {
          enabled: true,
          provider: "cloudflare",
          model: "openai/gpt-6-luna",
          reasoning: "medium",
        },
        translation: {
          enabled: true,
          provider: "anthropic",
          model: "claude-haiku-5-5",
          reasoning: "none",
        },
      },
    },
    modules: [Email()],
  })
);
```

## Props

| Prop          | What it sets                                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hostname`    | Required. Where the app is served, such as `mail.example.com`. It must be in a zone of your Cloudflare account. Passkeys and single sign-on apps are tied to it. |
| `mailDomains` | Required. Your mail domains, primary first. Every address in the workspace must be on one of them. See [Mail domains](deploy.md#mail-domains).                   |
| `ai`          | AI providers and the features that use them. See [AI](#ai).                                                                                                      |
| `modules`     | The apps in the workspace, such as `Email()`.                                                                                                                    |
| `apps`        | Single sign-on apps declared in code. See [Single sign-on](sso.md#declare-apps-in-code).                                                                         |
| `webhooks`    | Webhook endpoints declared in code. See [Webhooks](webhooks.md#declare-endpoints-in-code).                                                                       |
| `env`         | Extra Worker bindings or variables.                                                                                                                              |
| `mockAuth`    | Local development and tests only: a demo sign-in that works only on `localhost`.                                                                                 |
| `seed`, `dev` | Local development only: SQL files to load into the database, and the host and port for `alchemy dev`.                                                            |

`Email()` takes two options:

- `pushContact`: the `mailto:` or `https:` contact push services see, instead
  of the app's URL.
- `retention`: how many days a conversation stays in Trash or Spam before it is
  deleted permanently, as `{ trash, spam }`. Spam defaults to 30 days. Trash,
  or a folder set to `null`, keeps mail until someone empties it. For example,
  `Email({ retention: { trash: 30, spam: 14 } })`. Conversations already in
  Trash or Spam when this ships count from the upgrade.

### Removing a mail domain

If you take a domain out of `mailDomains` while addresses still use it, the
deploy still goes through. Those addresses keep working, but nobody can create
new ones on that domain, the domain stops receiving mail, and the admin screen
shows a notice.

To retire a domain cleanly:

1. Give each person and team on it an address on another domain. Make it the
   person's primary address.
2. Delete the old addresses.
3. Remove the domain from `mailDomains` and deploy.

## AI

AI is optional. Under `ai.providers` you name where models run, using any names
you like. Under `ai.features` you turn features on and point each at a
provider.

| `type`                          | Settings                                                                                                     | Model ids                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare`                    | `gateway` (optional; the account's default AI Gateway otherwise). No key: billed to your Cloudflare account. | Workers AI (`@cf/zai-org/glm-4.7-flash`), AI Gateway models (`openai/…`, `anthropic/…`, `google/…`), or `dynamic/…` routes |
| `openai`, `anthropic`, `google` | `apiKeyEnv` (required), `baseURL` and `headers` (optional)                                                   | The vendor's own ids (`gpt-5.5`, `claude-haiku-5-5`)                                                                       |
| `openai-compatible`             | `baseURL` (required), `apiKeyEnv` and `headers` (optional). For OpenRouter, vLLM, Ollama and similar.        | Whatever the endpoint accepts                                                                                              |

A feature you leave out, or set to `enabled: false`, is off.

| Feature          | What it does                                          |
| ---------------- | ----------------------------------------------------- |
| `classification` | Catches spam and sorts incoming mail into folders     |
| `translation`    | Translates messages and attachments when someone asks |

Each enabled feature sets `provider` (a name from `ai.providers`), `model`, and
optionally `reasoning`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`,
`max`, or `provider-default`.

API keys never go in `alchemy.run.ts`. `apiKeyEnv` names a variable, and you
put the key in `.env` under that name, for example `ANTHROPIC_API_KEY=…`. The
deploy fails if the key is missing.

Before you turn a feature on, check the provider's data-retention terms: the
model sees the full text of incoming mail. See [AI sorting](mail.md#ai-sorting)
for how it's used.

## Secrets

Secrets go in `.env` (or the environment) and are uploaded when you deploy.

| Name                                 | When you need it                                  |
| ------------------------------------ | ------------------------------------------------- |
| Each provider's `apiKeyEnv`          | Whenever that provider is declared                |
| `SPAMHAUS_DQS_KEY`                   | Optional. Turns on Spamhaus blocklist checks      |
| SCIM tokens of apps declared in code | Whatever names you read with `Config.Redacted(…)` |

You don't add signing keys, push keys, or storage credentials. The first deploy
creates them.
