import {
  bucket,
  env as coreEnv,
  hook,
  hooks as coreHooks,
} from "@open-workspace/core/testing";
import { z } from "zod";

import type { MailboxDO } from "./mailbox.ts";

/**
 * Email's stack, as its stack test files reach it: core's test client
 * (@open-workspace/core/testing) plus the mail bucket and the
 * mailbox Durable Objects.
 */
export {
  ORIGIN,
  useFreshWorkspace,
  worker,
} from "@open-workspace/core/testing";

/** Promise-returning versions of an object's methods, as an RPC stub has them. */
type Remote<T> = {
  [
    K in keyof T as T[K] extends (...args: never[]) => void ? K : never
  ]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

const methodName = z.string();

/** The mailbox Durable Object for a mailbox id, like `mailboxStub(env, id)` inside the Worker. */
export function mailbox(id: string): Remote<MailboxDO> {
  // SAFETY: the target is never read: `get` answers every method name with
  // an RPC call of that name (test/stack/worker.ts relays it to the object),
  // which is what `Remote<MailboxDO>` describes.
  const remote = {} as Remote<MailboxDO>;

  return new Proxy(remote, {
    get: (_, property) => {
      const method = methodName.safeParse(property);

      // Symbols and `then` are not methods: awaiting a remote must not call it.
      if (!method.success || method.data === "then") return undefined;

      return (...args: unknown[]) =>
        hook(`mailbox/${encodeURIComponent(id)}`, {
          method: method.data,
          args,
        });
    },
  });
}

/** A row of a mailbox's SQLite storage, as SQLite gives it. */
export type MailboxRow = Record<string, SqlStorageValue>;

export const hooks = {
  ...coreHooks,
  /** Runs the mailbox Durable Object's alarm now, if one is set; whether it ran. */
  runAlarm(mailboxId: string) {
    return mailbox(mailboxId).testRunAlarm();
  },
  /**
   * Rows of a query against a mailbox Durable Object's own SQLite storage,
   * typed as the caller says (`mailboxRows` checks them against a schema).
   */
  mailboxSql<T = MailboxRow>(
    mailboxId: string,
    query: string,
    ...params: unknown[]
  ) {
    return hook<T[]>(`mailbox/${encodeURIComponent(mailboxId)}`, {
      method: "testSql",
      args: [query, ...params],
    });
  },
  /** Rows of a query against a mailbox's own SQLite storage, each parsed with `row`. */
  async mailboxRows<S extends z.ZodType>(
    mailboxId: string,
    row: S,
    query: string,
    ...params: unknown[]
  ): Promise<z.output<S>[]> {
    return z
      .array(row)
      .parse(await mailbox(mailboxId).testSql(query, ...params));
  },
};

/** The stack's bindings tests read and write directly: D1, the mail bucket and the archive bucket. */
export const env = {
  ...coreEnv,
  MAIL_STORAGE: bucket("MAIL_STORAGE"),
  MAIL_ARCHIVE: bucket("MAIL_ARCHIVE"),
};
