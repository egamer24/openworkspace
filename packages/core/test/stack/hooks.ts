import { env as workerEnv } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { poll } from "../../testing/poll.ts";
import type { HookContext, TestHook } from "../../testing/test-hooks.ts";
import {
  createMailboxAddress,
  deleteMailboxAddress,
} from "../../worker/admin/mailbox-routes.ts";
import { revokeUserAccess } from "../../worker/auth/revocation.ts";
import { revokeUserSession } from "../../worker/auth/session-records.ts";
import {
  consumeChallenge,
  deleteExpiredChallenges,
  recordPasskeyUse,
} from "../../worker/auth/webauthn.ts";
import { createDb } from "../../worker/db/client.ts";
import type { Database } from "../../worker/db/client.ts";
import { mailboxes, users } from "../../worker/db/schema.ts";
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

/**
 * Runs `run` with a WEBHOOKS queue that records what it is sent; the
 * result, and the events queued once the deferred tasks are done.
 */
async function withRecordedWebhooks<T>(
  env: Env,
  run: (env: Env, defer: (task: Promise<unknown>) => void) => Promise<T>
) {
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

  const result = await run(
    { ...env, WEBHOOKS: webhooks },
    (task) => void tasks.push(task)
  );

  await Promise.all(tasks);

  return { result, events };
}

/**
 * A small module such as a throwaway-address one: it creates aliases of a
 * mailbox for a person, and deletes them once that person may no longer
 * send from it. Its own table is this map, alias id to creator.
 */
const moduleAliases = new Map<string, string>();

/** The aliases the module deleted on an access change, in order. */
const lostAliases: string[] = [];

let installedBeforeAliases: ReturnType<typeof workspaceModules> | undefined;

async function mayStillSend(env: Env, aliasId: string, userId: string) {
  const row = await env.DB.prepare(
    `SELECT 1 FROM mailboxes AS alias
     INNER JOIN mailbox_access ON mailbox_access.mailbox_id = alias.alias_of
     INNER JOIN users ON users.id = mailbox_access.user_id
     WHERE alias.id = ? AND mailbox_access.user_id = ?
       AND mailbox_access.can_send = 1 AND users.status = 'active'`
  )
    .bind(aliasId, userId)
    .first();

  return Boolean(row);
}

const aliasModule = {
  /** Installs the alias module; false removes it and forgets its aliases. */
  "modules.aliasModule": (_, on: boolean) => {
    installedBeforeAliases ??= workspaceModules();
    moduleAliases.clear();
    lostAliases.length = 0;

    installModules(
      on
        ? [
            ...installedBeforeAliases,
            {
              name: "aliases",
              hooks: {
                mailboxAccessChanged: async (env, defer) => {
                  const db = createDb(env.DB);

                  for (const [aliasId, userId] of moduleAliases) {
                    // oxlint-disable-next-line eslint/no-await-in-loop -- a test module with a handful of aliases
                    if (await mayStillSend(env, aliasId, userId)) continue;

                    // oxlint-disable-next-line eslint/no-await-in-loop -- as above
                    await deleteMailboxAddress(env, db, aliasId, defer);
                    moduleAliases.delete(aliasId);
                    lostAliases.push(aliasId);
                  }
                },
                mailboxDeleted: (_env, id) => {
                  moduleAliases.delete(id);

                  return Promise.resolve();
                },
              },
            },
          ]
        : installedBeforeAliases
    );
  },
  /**
   * Creates `address` as an alias of `aliasOf` for `userId`, through the
   * module API: the alias has its target's owner or team. The created id
   * or refusal, and the webhook events queued.
   */
  "modules.createAlias": (
    { env },
    aliasOf: string,
    address: string,
    userId: string
  ) =>
    withRecordedWebhooks(env, async (recording, defer) => {
      const db = createDb(env.DB);

      const [target] = await db
        .select({
          ownerUserId: mailboxes.ownerUserId,
          teamId: mailboxes.teamId,
        })
        .from(mailboxes)
        .where(eq(mailboxes.id, aliasOf))
        .limit(1);

      const created = await createMailboxAddress(
        recording,
        db,
        {
          address,
          displayName: "Throwaway",
          ownerUserId: target?.ownerUserId ?? null,
          teamId: target?.teamId ?? null,
          delivery: "alias",
          aliasOf,
        },
        userId,
        defer
      );

      if ("mailboxId" in created) moduleAliases.set(created.mailboxId, userId);

      return created;
    }),
  /** The aliases the module deleted since the last read. */
  "modules.lostAliases": () => lostAliases.splice(0),
} satisfies Record<string, TestHook>;

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
  "modules.deleteAddress": ({ env }, mailboxId: string) =>
    withRecordedWebhooks(env, (recording, defer) =>
      deleteMailboxAddress(recording, createDb(env.DB), mailboxId, defer)
    ),
} satisfies Record<string, TestHook>;

export const coreHooks = {
  ...identity,
  ...revocation,
  ...sso,
  ...addressHooks,
  ...aliasModule,
  /** The OIDC cleanup routes run at random; run it now. */
  "oidc.cleanupExpiredArtifacts": ({ env }) =>
    cleanupExpiredOidcArtifacts(createDb(env.DB)),
} satisfies Record<string, TestHook>;
