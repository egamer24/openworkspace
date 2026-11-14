import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import * as Cloudflare from "@alchemy.run/cloudflare";
import { VapidKeys } from "@open-workspace/core/alchemy";
import type { WorkspaceModuleInfra } from "@open-workspace/core/alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { z } from "zod";

import {
  EMAIL_MODULE,
  emailClasses,
  emailQueueRoles,
  JMAP_PATH,
} from "../shared/module.ts";
import { pdfjsAssetFolders, pdfjsAssetPath } from "../shared/pdfjs-assets.ts";

/** The package root, one up from alchemy/. */
const packageDir = resolve(import.meta.dirname, "..");

/** gotenberg/gotenberg:8.37.0, the multi-platform index. */
const officePreviewImage =
  "docker.io/gotenberg/gotenberg@sha256:f29984bd1e226bf1b93ba90af06000afa8b315853e99d27b9aaa41b93f15c769";

const PackageManifest = z.object({ version: z.string().min(1) });

/** The PDF.js resources the viewer requests by filename, copied into the browser app. */
function pdfjsAssets() {
  const pdfjsDir = dirname(
    createRequire(import.meta.url).resolve("pdfjs-dist/package.json")
  );

  const { version } = PackageManifest.parse(
    JSON.parse(readFileSync(join(pdfjsDir, "package.json"), "utf-8"))
  );

  return Object.values(pdfjsAssetFolders).map((folder) => ({
    from: join(pdfjsDir, folder),
    to: pdfjsAssetPath(version, folder),
  }));
}

/** Email Sending events that update delivery status in the app. */
const deliveryEvents = [
  "message.delivered",
  "message.bounced",
  "message.deferred",
  "message.complained",
  "message.failed",
  "message.rejected",
];

export type EmailInfraProps = {
  /** Contact for push services (mailto: or https:); defaults to the app's URL. */
  pushContact?: string;
  /**
   * Days a conversation stays in Trash or Spam before it is deleted
   * permanently. Spam defaults to 30; Trash, or a folder set to null, keeps
   * mail until someone empties it.
   */
  retention?: { trash?: number | null; spam?: number | null };
};

/** Optional secrets the module reads, bound when set in the environment or `.env`. */
const emailSecrets = [
  // Spamhaus Data Query Service key, for blocklist checks.
  "SPAMHAUS_DQS_KEY",
  // Email Routing's API (worker/mail/email-routing.ts). Deployed, `Email()`
  // mints and binds them; under `alchemy dev` they're bound only when set,
  // as the stack tests do for their fake API.
  "EMAIL_ROUTING_ACCOUNT_ID",
  "EMAIL_ROUTING_API_TOKEN",
] as const;

function emailResources() {
  return {
    officePreviews: Cloudflare.Queues.Queue("OfficePreviews", {}),
    pushNotifications: Cloudflare.Queues.Queue("PushNotifications", {}),
    deliveryEvents: Cloudflare.Queues.Queue("DeliveryEvents", {}),
  };
}

/**
 * The mail bucket. Browsers upload attachments to it and download them from
 * it with presigned URLs, so its CORS lets the app's origin PUT, GET and
 * HEAD. Under `alchemy dev` the app and the local S3 endpoint share an
 * origin, so the local bucket needs none.
 */
const mailStorage = (origin: string, dev: boolean) => {
  const props: Cloudflare.R2.BucketProps = {
    // Uploads that were never sent.
    lifecycleRules: [
      {
        id: "expire-composer-uploads",
        prefix: "composer-uploads/",
        deleteObjectsTransition: {
          condition: { type: "Age", maxAge: 7 * 24 * 60 * 60 },
        },
      },
    ],
  };

  if (!dev) {
    props.cors = [
      {
        id: "direct-transfers",
        allowedOrigins: [origin],
        allowedMethods: ["GET", "PUT", "HEAD"],
        allowedHeaders: ["Content-Type"],
        maxAgeSeconds: 3600,
      },
    ];
  }

  return Cloudflare.R2.Bucket("MailStorage", props);
};

/**
 * An account API token that may only manage Email Routing destination
 * addresses, for forwards (worker/mail/email-routing.ts), and its account.
 * Minted when deployed; `alchemy dev` has no Email Routing to call.
 */
const emailRoutingToken = () =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

    const token = yield* Cloudflare.ApiToken.AccountApiToken(
      "EmailRoutingToken",
      {
        policies: [
          {
            effect: "allow",
            permissionGroups: ["Email Routing Addresses Write"],
            resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
          },
        ],
      }
    );

    return {
      EMAIL_ROUTING_ACCOUNT_ID: token.accountId,
      EMAIL_ROUTING_API_TOKEN: token.value,
    };
  });

/** The contact push services see, bound only when configured. */
type PushSubjectEnv = { VAPID_SUBJECT?: string };

/** `Email({ retention })` in days, bound only for folders that delete mail. */
type RetentionEnv = {
  TRASH_RETENTION_DAYS?: string;
  SPAM_RETENTION_DAYS?: string;
};

function retentionEnv({
  trash = null,
  spam = 30,
}: EmailInfraProps["retention"] = {}) {
  const env: RetentionEnv = {};

  for (const [name, days] of [
    ["TRASH_RETENTION_DAYS", trash],
    ["SPAM_RETENTION_DAYS", spam],
  ] as const) {
    if (days === null) continue;

    if (!Number.isInteger(days) || days < 1) {
      throw new Error(
        `Email({ retention }) takes whole days of 1 or more, not ${days}`
      );
    }

    env[name] = String(days);
  }

  return env;
}

/** The module's Worker bindings; the Worker's `Env` is derived from them (`EmailEnv`). */
const emailEnv = (
  props: EmailInfraProps,
  resources: ReturnType<typeof emailResources>,
  origin: string
) =>
  Effect.gen(function* () {
    const alchemy = yield* Effect.serviceOption(AlchemyContext);
    const dev = Option.isSome(alchemy) && alchemy.value.dev;
    const vapid = yield* VapidKeys("VapidKeys", {});
    // Signs the remote image proxy's tokens; minted once, kept in state.
    const remoteKey = yield* Random("MailRemoteKey", { bytes: 32 });
    const bucket = mailStorage(origin, dev);
    // Push services see the configured contact; without one the Worker
    // falls back to the app's URL, so the binding is left out.
    const pushSubject: PushSubjectEnv = {};

    if (props.pushContact) pushSubject.VAPID_SUBJECT = props.pushContact;

    const emailRouting: Partial<
      Effect.Success<ReturnType<typeof emailRoutingToken>>
    > = dev ? {} : yield* emailRoutingToken();

    return {
      /**
       * S3 credentials for the mail bucket alone, as JSON, for presigned
       * attachment transfers: from an API token Alchemy mints when
       * deployed, the local S3 endpoint under `alchemy dev`.
       */
      MAIL_S3: Cloudflare.R2.S3Credentials(bucket, { access: "read-write" }),
      /** Web Push keys Alchemy mints, and the contact push services see. */
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      ...pushSubject,
      ...retentionEnv(props.retention),
      ...emailRouting,
      MAIL_STORAGE: bucket,
      /** Signs the remote image proxy's tokens (mail/remote-token.ts). */
      MAIL_REMOTE_KEY: remoteKey.text,
      EMAIL: Cloudflare.Email.SendEmail("EMAIL"),
      MAILBOX: Cloudflare.DurableObject("MAILBOX", {
        className: emailClasses.MAILBOX,
      }),
      // Gotenberg straight from Docker Hub, pinned by digest. Cloudflare
      // pulls it itself, so a deploy needs no local Docker. Only local
      // Office uploads are converted: documents can't reach the network.
      OFFICE_PREVIEW_CONTAINER: Cloudflare.Container("OfficePreview", {
        className: emailClasses.OFFICE_PREVIEW_CONTAINER,
        image: officePreviewImage,
        registryId: "docker.io",
        env: {
          CHROMIUM_DISABLE_ROUTES: "true",
          API_DISABLE_DOWNLOAD_FROM: "true",
          WEBHOOK_DISABLE: "true",
          LIBREOFFICE_DENY_LIST: ".*",
          API_TIMEOUT: "90s",
        },
        maxInstances: 2,
      }),
      OFFICE_PREVIEWS: resources.officePreviews,
      PUSH_NOTIFICATIONS: resources.pushNotifications,
    };
  });

/**
 * The bindings `Email()` adds, as the Worker sees them: the module's part of
 * `Env` (worker/bindings.d.ts).
 */
export type EmailEnv = Cloudflare.InferEnv<
  Effect.Success<ReturnType<typeof emailEnv>>
> &
  Partial<Record<(typeof emailSecrets)[number], string>>;

/**
 * The mail module's Cloudflare resources: the mail bucket, a SQLite Durable
 * Object per mailbox, the Office preview container, its queues, and the
 * outbound mail binding. For each of the workspace's `mailDomains` (each a zone
 * in the account) it turns on Email Routing, which adds and locks the zone's
 * MX and SPF records, sends every address to the Worker, onboards the domain
 * to Email Sending, and queues its delivery events.
 */
export function Email(props: EmailInfraProps = {}): WorkspaceModuleInfra {
  const resources = emailResources();

  const {
    officePreviews,
    pushNotifications,
    deliveryEvents: deliveryEventsQueue,
  } = resources;

  return {
    name: EMAIL_MODULE,
    // index.ts default-exports `email()`, and exports the classes MAILBOX and OFFICE_PREVIEW_CONTAINER name.
    server: {
      entry: join(packageDir, "index.ts"),
      classes: Object.values(emailClasses),
    },
    routes: [JMAP_PATH],
    migrations: join(packageDir, "migrations"),
    client: {
      entry: join(packageDir, "src", "client.tsx"),
      assets: pdfjsAssets(),
    },
    secrets: [...emailSecrets],
    env: ({ origin }) => emailEnv(props, resources, origin),
    consumers: [
      // Each preview converts in a container; two at a time.
      {
        id: "OfficePreviewsConsumer",
        role: emailQueueRoles.officePreviews,
        queue: officePreviews,
        settings: {
          batchSize: 1,
          maxConcurrency: 2,
          maxRetries: 5,
          maxWaitTimeMs: 1000,
        },
      },
      {
        id: "PushNotificationsConsumer",
        role: emailQueueRoles.pushNotifications,
        queue: pushNotifications,
        settings: { batchSize: 10, maxRetries: 5, maxWaitTimeMs: 2000 },
      },
      {
        id: "DeliveryEventsConsumer",
        role: emailQueueRoles.deliveryEvents,
        queue: deliveryEventsQueue,
        settings: { batchSize: 10, maxRetries: 5, maxWaitTimeMs: 5000 },
      },
    ],
    afterWorker: ({ workerName, config }) =>
      Effect.gen(function* () {
        // Email Routing, Email Sending and event subscriptions have no local
        // emulation, so under `alchemy dev` (the dev, stack-test and e2e
        // stacks) they would act on the real zones. Locally, sent mail goes
        // to the EMAIL binding's local runtime instead.
        const alchemy = yield* Effect.serviceOption(AlchemyContext);

        if (Option.isSome(alchemy) && alchemy.value.dev) return;
        const { queueId: deliveryQueueId } = yield* deliveryEventsQueue;

        for (const domain of config.mailDomains) {
          const id = domain.replaceAll(".", "-");

          const routing = yield* Cloudflare.Email.Routing(`Routing-${id}`, {
            zone: domain,
          });

          yield* Cloudflare.Email.CatchAll(`CatchAll-${id}`, {
            zone: routing.zoneId,
            actions: [{ type: "worker", value: [workerName] }],
          });
          yield* Cloudflare.Email.SendingSubdomain(`Sending-${id}`, {
            zoneId: routing.zoneId,
            name: domain,
          });
          yield* Cloudflare.Queues.Subscription(`DeliveryEvents-${id}`, {
            source: { type: "email.sending", zoneId: routing.zoneId, domain },
            events: deliveryEvents,
            queueId: deliveryQueueId,
          });
        }
      }),
  };
}
