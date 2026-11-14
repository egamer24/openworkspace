import { required } from "@open-workspace/core/shared";
import { clearBucket, testWorker } from "@open-workspace/core/testing/worker";
import { z } from "zod";

import { fakeDohResponse, isDohRequest } from "./fake-doh.ts";
import { emailHooks } from "./hooks/index.ts";
import type { MailboxDO } from "./mailbox.ts";

// The mailbox Durable Object, with test-only methods the mailbox route calls;
// the generated entry exports it in place of email's (stack.ts lists it).
export { MailboxDO } from "./mailbox.ts";

/** A method call on a mailbox Durable Object, as `mailbox(id)` in workspace.ts sends it. */
const rpcCallSchema = z.object({
  method: z.string().min(1),
  args: z.array(z.unknown()),
});

/** What any method of the test mailbox Durable Object resolves to. */
type MailboxResult = {
  [K in keyof MailboxDO]: MailboxDO[K] extends (...args: never[]) => infer R
    ? Awaited<R>
    : never;
}[keyof MailboxDO];

/** A Durable Object stub seen as what it is on the wire: methods called by name. */
type RpcRelay = Record<string, (...args: unknown[]) => Promise<MailboxResult>>;

// Email's test Worker: the generated entry passes the workspace (core and the mail module) to this wrap.
export default testWorker({
  hooks: emailHooks,
  // Mail, uploads and archived copies go with the rows that point to them.
  reset: async (env) => {
    await clearBucket(env.MAIL_STORAGE);

    if (env.MAIL_ARCHIVE) await clearBucket(env.MAIL_ARCHIVE);
  },
  // Sender intelligence's DNS lookups, answered offline.
  answer: (request) =>
    isDohRequest(request) ? fakeDohResponse(request) : undefined,
  routes: {
    // { method, args } on the mailbox Durable Object named by the path, as an RPC call.
    async mailbox({ env, input, path }) {
      const { method, args } = rpcCallSchema.parse(input);

      const stub = env.MAILBOX.getByName(
        decodeURIComponent(required(path[0], "the path names a mailbox"))
      );

      const relay: object = stub;

      // SAFETY: an RPC stub forwards a call of any name to the object, and
      // the test stack binds MAILBOX to this file's MailboxDO (stack.ts), so
      // the names `mailbox(id)` sends are its methods; a wrong name or
      // arguments reject as a failed call, which is answered below.
      const call = (relay as RpcRelay)[method];

      try {
        return await call(...args);
      } catch (error) {
        // The test sees the method's own error, as a rejected RPC call.
        return new Response(
          error instanceof Error ? error.message : String(error),
          { status: 500 }
        );
      }
    },
  },
});
