import { z } from "zod";

import { consumeInOrder } from "./lib/queue";
import {
  BackchannelLogoutError,
  deliverBackchannelLogout,
} from "./oidc/backchannel-logout";
import { requestScimSync, syncScimConnection } from "./scim/sync";

const identitySyncJobSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("scim-sync"), connectionId: z.string().min(1) }),
  z.object({
    type: z.literal("backchannel-logout"),
    clientId: z.string().min(1),
    userId: z.string().min(1),
  }),
]);

/** The identity-sync queue keeps SSO applications in step with the workspace: SCIM provisioning and back-channel logout. */
export function consumeIdentitySync(batch: MessageBatch, env: Env) {
  return consumeInOrder(batch, {
    queueName: "identity sync",
    schema: identitySyncJobSchema,
    run: async (job) => {
      if (job.type === "scim-sync") {
        await syncScimConnection(env, job.connectionId);
      } else {
        await deliverBackchannelLogout(env, job);
      }
    },
    // A logout the client refuses for good is not retried.
    settled: (_job, cause) =>
      Promise.resolve(
        cause instanceof BackchannelLogoutError && !cause.retryable
      ),
    retryBaseSeconds: 30,
  });
}

/** The hourly safety net for changes whose sync request was lost. */
export function scheduledIdentitySync(env: Env) {
  return requestScimSync(env);
}
