# @open-workspace/core

[OpenWorkspace](https://openworkspace.dev) is a self-hosted workspace that runs
on your own Cloudflare account. Core is the platform: passkey sign-in, people,
teams, administration, an OIDC and SAML identity provider with SCIM
provisioning, webhooks, an MCP server, and the host for modules such as
[@open-workspace/email](https://www.npmjs.com/package/@open-workspace/email).

Start a deployment with:

```sh
bun create @open-workspace
```

## Usage

A deployment is one file, `alchemy.run.ts`:

```ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import { OpenWorkspace, providers } from "@open-workspace/core/alchemy";
import { Email } from "@open-workspace/email/alchemy";
import * as Alchemy from "alchemy";

export default Alchemy.Stack(
  "Workspace",
  { providers: providers(), state: Cloudflare.state() },
  OpenWorkspace({
    hostname: "mail.acme.com",
    mailDomains: ["acme.com"],
    modules: [Email()],
  })
);
```

| Prop          |                                                              |
| ------------- | ------------------------------------------------------------ |
| `hostname`    | Where the app is served, in a zone of the account. Required. |
| `mailDomains` | Mail domains, primary first. Required.                       |
| `ai`          | AI providers and the features that use them.                 |
| `backups`     | Daily snapshots to a bucket of their own, e.g. `{}`.         |
| `modules`     | Workspace modules, such as `Email()`.                        |
| `apps`        | Single sign-on apps declared in code.                        |
| `webhooks`    | Webhook endpoints declared in code.                          |
| `env`         | Extra Worker bindings or variables.                          |
| `dev`         | The local server for `bun run dev`, e.g. `{ port: 5173 }`.   |

## Documentation

- [Configuration](https://openworkspace.dev/docs/configuration)
- [Deploying](https://openworkspace.dev/docs/deploy)
- [Single sign-on, with apps and Cloudflare Access in code](https://openworkspace.dev/docs/sso#declare-apps-in-code)
- [Webhooks](https://openworkspace.dev/docs/webhooks)
- [Writing a module](https://openworkspace.dev/docs/modules)
- [Development](https://openworkspace.dev/docs/development)
