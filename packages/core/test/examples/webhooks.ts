import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  OpenWorkspace,
  providers,
  Webhook,
} from "@open-workspace/core/alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

/*
 * The docs' example of a webhook endpoint declared in alchemy.run.ts
 * (docs/webhooks.md, core's README), typechecked (`bun run typecheck`) but
 * never deployed: the receiving Worker is given the minted secret.
 */

export const billingWebhook = Alchemy.Stack(
  "Workspace",
  { providers: providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const billing = yield* Webhook("Billing", {
      name: "Billing",
      url: "https://billing.acme.com/hooks/workspace",
      events: ["user.joined", "user.updated"],
    });

    yield* OpenWorkspace({
      hostname: "mail.acme.com",
      mailDomains: ["acme.com"],
      webhooks: [billing],
    });

    yield* Cloudflare.Worker("BillingWorker", {
      main: "./billing/worker.ts",
      env: { WORKSPACE_WEBHOOK_SECRET: billing.secret },
    });
  })
);
