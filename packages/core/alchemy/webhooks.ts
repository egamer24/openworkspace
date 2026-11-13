import { randomBytes } from "node:crypto";

import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { declaredWebhookSchema } from "../shared/webhook-declarations.ts";
import type { WebhookEventType } from "../shared/webhooks.ts";

export type WebhookProps = {
  name: string;
  /** Where events are POSTed; https only. */
  url: string;
  /** Event types, e.g. "user.joined" or a module's "email.received"; checked against the workspace's events when the Worker applies it. */
  events: WebhookEventType[];
  enabled?: boolean;
};

export type Webhook = Resource<
  "OpenWorkspace.Webhook",
  WebhookProps,
  {
    webhookId: string;
    /** The Standard Webhooks signing secret; give it to the receiving service. */
    secret: Redacted.Redacted<string>;
    /** What the Worker stores, secret included. */
    declaration: Redacted.Redacted<string>;
  }
>;

/**
 * A webhook endpoint the workspace delivers events to, declared in code. Its
 * signing secret is minted once and kept in the stack's state, so the
 * receiving Worker can be given it in the same file. Read-only in the admin UI.
 */
export const Webhook = Resource<Webhook>("OpenWorkspace.Webhook");

const webhookProvider = Provider.succeed(Webhook, {
  reconcile: ({
    news,
    output,
  }: {
    news: WebhookProps;
    output?: Webhook["Attributes"];
  }) =>
    Effect.sync(() => {
      const webhookId =
        output?.webhookId ?? `whk_${randomBytes(16).toString("hex")}`;

      const secret =
        output?.secret ??
        Redacted.make(`whsec_${randomBytes(32).toString("base64")}`);

      const declaration = declaredWebhookSchema.parse({
        id: webhookId,
        name: news.name,
        url: news.url,
        events: news.events,
        enabled: news.enabled ?? true,
        secret: Redacted.value(secret),
      });

      return {
        webhookId,
        secret,
        declaration: Redacted.make(JSON.stringify(declaration)),
      };
    }),
  delete: () => Effect.void,
  read: ({ output }: { output?: Webhook["Attributes"] }) =>
    Effect.succeed(output),
  list: () => Effect.succeed([]),
});

/** The provider for `Webhook`. */
export const webhookProviders = () => webhookProvider;
