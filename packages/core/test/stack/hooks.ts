import { env as workerEnv } from "cloudflare:workers";
import { z } from "zod";

import { poll } from "../../testing/poll.ts";
import type { HookContext, TestHook } from "../../testing/test-hooks.ts";
import { deleteMailboxAddress } from "../../worker/admin/mailbox-routes.ts";
import { revokeUserAccess } from "../../worker/auth/revocation.ts";
import { revokeUserSession } from "../../worker/auth/session-records.ts";
import {
  consumeChallenge,
  deleteExpiredChallenges,
  recordPasskeyUse,
} from "../../worker/auth/webauthn.ts";
import { createDb } from "../../worker/db/client.ts";
import type { Database } from "../../worker/db/client.ts";
import { users } from "../../worker/db/schema.ts";
import { installModules, workspaceModules } from "../../worker/modules.ts";
import {
  BackchannelLogoutError,
  deliverBackchannelLogout,
} from "../../worker/oidc/backchannel-logout.ts";
import { cleanupExpiredOidcArtifacts } from "../../worker/oidc/service.ts";
import {
  syncScimConnection,
  testScimConnection,
} from "../../worker/scim/sync.ts";
import {
  resetDeclaredSsoApps,
  syncDeclaredSsoApps,
} from "../../worker/sso/declared-apps.ts";
import {
  resetDeclaredWebhooks,
  syncDeclaredWebhooks,
} from "../../worker/webhooks/declared.ts";

/**
 * Core's named test hooks (`hooks.call(name, ...args)`), for what only code
 * inside the Worker can do: drive the WebAuthn challenge store, SCIM syncs
 * and back-channel logouts by hand, swap declared apps and webhooks, run
 * the OIDC cleanup now.
 */

/**
 * The WebAuthn challenge store has no route of its own outside a real
 * passkey ceremony, so these run its functions in the Worker. A thrown
 * error comes back as `{ error }`, for the test to assert on.
 */
async function outcome<T>(run: () => Promise<T>) {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const identity = {
  "identity.consumeChallenge": (
    { env },
    id: string,
    kind: Parameters<typeof consumeChallenge>[2]
  ) => outcome(() => consumeChallenge(createDb(env.DB), id, kind)),
  "identity.deleteExpiredChallenges": ({ env }) =>
    outcome(() => deleteExpiredChallenges(createDb(env.DB))),
  // Both updates at once, in the order given, as overlapping sign-ins run them.
  "identity.recordPasskeyUses": (
    { env },
    credentialId: string,
    counters: number[]
  ) =>
    outcome(() =>
      Promise.all(
        counters.map((counter) =>
          recordPasskeyUse(createDb(env.DB), credentialId, counter)
        )
      )
    ),
} satisfies Record<string, TestHook>;

/**
 * A statement that fails when it runs, after core's own deletes in the
 * batch: the person's row inserted again, against its primary key.
 */
function failingStatements(db: Database, userId: string) {
  return [db.insert(users).values({ id: userId, name: "Duplicate" })];
}

/**
 * Runs `revoke` with a module installed whose session hooks contribute a
 * failing statement, then puts the workspace's own modules back.
 */
async function withFailingModule<T>(revoke: () => Promise<T>) {
  const modules = workspaceModules();

  installModules([
    ...modules,
    {
      name: "failing",
      hooks: {
        sessionRevoked: (db, session) => failingStatements(db, session.userId),
        sessionsRevoked: failingStatements,
      },
    },
  ]);

  try {
    return await outcome(revoke);
  } finally {
    installModules(modules);
  }
}

/** Session revocations whose module statement fails, to show they are one batch. */
const revocation = {
  "revocation.revokeSessionWithFailingModule": (
    { env },
    userId: string,
    sessionId: string
  ) =>
    withFailingModule(() =>
      revokeUserSession(createDb(env.DB), userId, sessionId)
    ),
  "revocation.revokeAccessWithFailingModule": ({ env, ctx }, userId: string) =>
    withFailingModule(() =>
      revokeUserAccess(env, createDb(env.DB), userId, {
        defer: (task) => ctx.waitUntil(task),
      })
    ),
} satisfies Record<string, TestHook>;

/**
 * Replaces a binding's value for every later request in this isolate, as
 * a redeploy with other declarations would. Tests put the original back.
 */
function rebind(
  { env }: HookContext,
  name: "SSO_APPS" | "DECLARED_WEBHOOKS",
  value: string
) {
  for (const target of [env, workerEnv]) target[name] = value;
}

/** SSO, SCIM, back-channel logout, and declared apps/webhooks. */
const sso = {
  /** Declares these SSO apps (JSON) as alchemy.run.ts would; they apply on the next sync. */
  "sso.declareApps": (context, json: string) => {
    rebind(context, "SSO_APPS", json);
    resetDeclaredSsoApps();
  },
  "sso.syncDeclaredApps": ({ env }) => syncDeclaredSsoApps(env),
  /** Declares these webhook endpoints (JSON); they apply on the next sync. */
  "sso.declareWebhooks": (context, json: string) => {
    rebind(context, "DECLARED_WEBHOOKS", json);
    resetDeclaredWebhooks();
  },
  "sso.syncDeclaredWebhooks": ({ env }) => syncDeclaredWebhooks(env),
  "sso.testScim": (_, baseUrl: string, token: string) =>
    testScimConnection(baseUrl, token),
  /**
   * One SCIM sync run. With `waitForLease`, a run the live identity-sync
   * consumer holds is waited out first, so the result is this call's own.
   */
  "sso.syncScim": ({ env }, connectionId: string, waitForLease = false) =>
    poll(
      () => syncScimConnection(env, connectionId),
      (result) => result !== "skipped" || !waitForLease,
      { interval: 200 }
    ),
  /** Delivers one back-channel logout; the error, if it failed. */
  "sso.deliverBackchannelLogout": async (
    { env },
    job: { clientId: string; userId: string }
  ) => {
    try {
      await deliverBackchannelLogout(env, job);

      return null;
    } catch (error) {
      if (!(error instanceof BackchannelLogoutError)) throw error;

      return { message: error.message, retryable: error.retryable };
    }
  },
} satisfies Record<string, TestHook>;

/** A queued webhook event, as far as these tests read it. */
const recordedJob = z.object({
  eventType: z.string(),
  source: z.object({
    data: z
      .object({ mailbox: z.object({ id: z.string() }).optional() })
      .optional(),
  }),
});

/** What modules' address hooks were called with, in order. */
const addressHookCalls: string[] = [];

let installedBeforeRecording: ReturnType<typeof workspaceModules> | undefined;

/** Mailbox hooks a module sees, and deletions with their webhook events. */
const addressHooks = {
  /** Installs a module that records `mailboxSaved`/`mailboxDeleted`; false removes it. */
  "modules.recordAddressHooks": (_, on: boolean) => {
    installedBeforeRecording ??= workspaceModules();
    addressHookCalls.length = 0;

    installModules(
      on
        ? [
            ...installedBeforeRecording,
            {
              name: "recorder",
              hooks: {
                mailboxSaved: (_env, id) => {
                  addressHookCalls.push(`saved ${id}`);

                  return Promise.resolve();
                },
                mailboxDeleted: (_env, id) => {
                  addressHookCalls.push(`deleted ${id}`);

                  return Promise.resolve();
                },
              },
            },
          ]
        : installedBeforeRecording
    );
  },
  /** The recorded calls since the last read. */
  "modules.addressHookCalls": () => addressHookCalls.splice(0),
  /** Deletes an address as the admin API does; the webhook events it queued. */
  "modules.deleteAddress": async ({ env }, mailboxId: string) => {
    const events: { eventType: string; mailboxId: string }[] = [];
    const tasks: Promise<unknown>[] = [];

    const noBacklog = { backlogCount: 0, backlogBytes: 0 };

    const record = (job: z.infer<typeof recordedJob>) => {
      events.push({
        eventType: job.eventType,
        mailboxId: job.source.data?.mailbox?.id ?? "",
      });
    };

    const webhooks: Env["WEBHOOKS"] = {
      metrics: () => Promise.resolve(noBacklog),
      send: (body) => {
        record(recordedJob.parse(body));

        return Promise.resolve({ metadata: { metrics: noBacklog } });
      },
      sendBatch: (messages) => {
        for (const message of messages) record(recordedJob.parse(message.body));

        return Promise.resolve({ metadata: { metrics: noBacklog } });
      },
    };

    const result = await deleteMailboxAddress(
      { ...env, WEBHOOKS: webhooks },
      createDb(env.DB),
      mailboxId,
      (task) => void tasks.push(task)
    );

    await Promise.all(tasks);

    return { result, events };
  },
} satisfies Record<string, TestHook>;

export const coreHooks = {
  ...identity,
  ...revocation,
  ...sso,
  ...addressHooks,
  /** The OIDC cleanup routes run at random; run it now. */
  "oidc.cleanupExpiredArtifacts": ({ env }) =>
    cleanupExpiredOidcArtifacts(createDb(env.DB)),
} satisfies Record<string, TestHook>;
