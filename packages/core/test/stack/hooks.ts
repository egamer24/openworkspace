import { env as workerEnv } from "cloudflare:workers";

import { poll } from "../../testing/poll.ts";
import type { HookContext, TestHook } from "../../testing/test-hooks.ts";
import {
  consumeChallenge,
  deleteExpiredChallenges,
  recordPasskeyUse,
} from "../../worker/auth/webauthn.ts";
import { createDb } from "../../worker/db/client.ts";
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

export const coreHooks = {
  ...identity,
  ...sso,
  /** The OIDC cleanup routes run at random; run it now. */
  "oidc.cleanupExpiredArtifacts": ({ env }) =>
    cleanupExpiredOidcArtifacts(createDb(env.DB)),
} satisfies Record<string, TestHook>;
