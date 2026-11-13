# Deploy

OpenWorkspace runs in your own Cloudflare account. One command sets up a
project and deploys it.

## What you need

- [Bun](https://bun.sh)
- A Cloudflare account on the Workers Paid plan
- Each mail domain added to that account as a zone. The hostname the app is
  served on must be in one of those zones too.

## Create and deploy

```sh
bun create @open-workspace
```

The command asks you a few things, then deploys:

1. A project name. It creates the folder (for example `acme-workspace/`) and
   installs dependencies.
2. A Cloudflare sign-in. If you're already signed in through Alchemy, it reuses
   that login. Otherwise a browser opens: choose **OAuth** and **All Scopes**,
   then approve.
3. Which Cloudflare account to use, if your login reaches more than one.
4. Your mail domains, picked from the account's zones. If you pick several, you
   also choose the primary one.
5. The hostname for the app. It defaults to `mail.<primary domain>`.
6. An AI provider: Cloudflare AI Gateway, OpenAI, Anthropic, or none. For
   OpenAI or Anthropic it asks for an API key, unless `OPENAI_API_KEY` or
   `ANTHROPIC_API_KEY` is already set.

It then writes the project, makes a first git commit, and runs
`bun run deploy`.

The project has three files you'll work with:

| File             | What it's for                                                                 |
| ---------------- | ----------------------------------------------------------------------------- |
| `alchemy.run.ts` | Your workspace's settings. See [Configuration](configuration.md).             |
| `.env`           | API keys for outside services, uploaded as secrets on deploy. Git ignores it. |
| `package.json`   | The `deploy`, `dev`, `destroy` and `logs` scripts.                            |

If you skip the deploy, or it fails, the project stays. Fix the problem and run:

```sh
cd acme-workspace
bun run deploy
```

To sign in with an API token instead of a browser login, set
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment.

## Sign in for the first time

Open `https://<hostname>`. On a new workspace, the first screen asks for your
name and a personal address on one of your mail domains, and registers a
passkey. You become the administrator. From there you can invite everyone else
(see [Mail](mail.md)).

## Mail domains

Each deploy connects your mail domains to Cloudflare Email Routing and Email
Sending. Cloudflare adds the MX, SPF, DKIM and DMARC records for you.

Before you deploy, remove any MX records from another mail provider. The deploy
fails while they're there. `bun create @open-workspace` checks for them, shows
them to you, and lets you check again once you've removed them.

If you're moving from another provider, import people and mail first, then
switch the MX records. See [Migration](migration.md#cutover-steps).

Only addresses you create in the workspace receive mail. Mail to any other
address on your domains is rejected.

## After the first deploy

These two steps are optional:

- With the Cloudflare AI provider, add credits in the Cloudflare dashboard
  under **AI → AI Gateway → Credits Available → Manage**. AI features stop
  working when credits run out, including in local development. See
  [AI](configuration.md#ai).
- For Spamhaus blocklist checks on incoming mail, get a Data Query Service key
  from Spamhaus and add it to `.env` as `SPAMHAUS_DQS_KEY`, then deploy again.

Push notifications need no setup. People turn them on under
**Settings → Notifications**.

Profile photos and the logo are resized by Cloudflare's Images binding. You
don't need an Images subscription: the first 5,000 resizes a month are free,
and each photo uses at most two. Past that limit, without the Images Paid plan,
the original image is shown until the month ends.

## Update

```sh
bun update @open-workspace/core @open-workspace/email
bun run deploy
```

## Keep the Alchemy state

Alchemy keeps your workspace's signing keys in its state. If you lose the
state, the next deploy creates new keys: you'll have to give your SAML apps the
new certificate, and people will have to turn push notifications on again.
OIDC apps pick up the new key on their own.

## Scripted runs

With `--yes`, or without a terminal, the command asks nothing. It uses the
defaults below and stops when it needs a choice it can't make.

```sh
bun create @open-workspace acme-workspace --yes \
  --account "Acme" --mail-domains acme.com,acme.org --hostname mail.acme.com --ai cloudflare
```

| Flag                    | Default                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| `--account <id\|name>`  | The only account; required when the login reaches several             |
| `--profile <name>`      | `$ALCHEMY_PROFILE`, else `default`                                    |
| `--mail-domains <list>` | The account's only zone; required when it has several                 |
| `--hostname <host>`     | `mail.<primary domain>`                                               |
| `--ai <provider>`       | `cloudflare`; also `openai`, `anthropic` (key from the env) or `none` |
| `--no-deploy`           | Off: the project is deployed                                          |
| `--no-git`              | Off: a git repository is created                                      |
| `--yes`, `-y`           | Off: you're asked for anything without a default                      |

A scripted run can't open a browser to sign in. It needs an existing Alchemy
login (from an earlier interactive run), or `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. It won't deploy while a mail domain has another
provider's MX records.
