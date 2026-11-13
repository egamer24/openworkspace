import type {
  WebhookDeliveryJob,
  WebhookDispatchJob,
} from "@open-workspace/core/module";
import { required } from "@open-workspace/core/shared";
import { consumeWebhooks } from "@open-workspace/core/testing/worker";
import type { TestHook } from "@open-workspace/core/testing/worker";
import {
  deferEmailSentWebhook,
  submitOutgoing,
} from "@open-workspace/email/worker/mail/outbound-service.ts";
import {
  discardPreparedObjects,
  prepareOutgoingEmail,
} from "@open-workspace/email/worker/mail/outbound.ts";
import {
  createComposerUploadIntent,
  discardComposerUploads,
  finalizeComposerUpload,
  loadComposerUpload,
  loadComposerUploadMetadata,
  storeComposerUploadContent,
} from "@open-workspace/email/worker/mail/uploads.ts";
import { workspaceFeedbackSummary } from "@open-workspace/email/worker/mail/workspace-safety.ts";

import { bucketWith, fakeQueue, messageBatch, queueMessage } from "./fakes.ts";

/**
 * Mail-flow stack tests (composer uploads, outbound rollback, webhooks, mail
 * safety): the upload and outbound functions run here, inside the Worker,
 * with the fakes the tests need (a bucket whose deletes wait, whose puts
 * fail, or whose reads interleave two finalizers; a webhooks queue that
 * records what it is sent) built from the real bindings.
 */

/** A thrown error as a value, so a test can assert on its class and message. */
type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: { name: string; message: string } };

async function outcome<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    const thrown = error instanceof Error ? error : new Error(String(error));

    return {
      ok: false,
      error: { name: thrown.constructor.name, message: thrown.message },
    };
  }
}

function gate() {
  let release = () => {};

  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { opened, release };
}

export type UploadCall =
  | {
      fn: "createIntent";
      input: Omit<Parameters<typeof createComposerUploadIntent>[0], "env">;
    }
  | {
      fn: "finalize" | "load" | "loadMetadata";
      input: { mailboxId: string; userId: string; uploadId: string };
    }
  | {
      fn: "discard";
      input: { mailboxId: string; userId: string; uploadIds: string[] };
    }
  | {
      fn: "store";
      input: {
        mailboxId: string;
        userId: string;
        uploadId: string;
        contentType: string;
        contentLength?: number;
      };
      /** The body, sent as a Blob or, with `stream`, as a stream of unknown length. */
      body: Uint8Array<ArrayBuffer>;
      stream?: boolean;
    };

/** A request's `ctx.waitUntil` stand-in that keeps the deferred tasks. */
function deferrals() {
  const tasks: Promise<unknown>[] = [];

  return { tasks, defer: (task: Promise<unknown>) => void tasks.push(task) };
}

export const hooks = {
  /** One function of uploads.ts, on the real bindings. */
  "mailFlow.uploads": ({ env }, call: UploadCall) => {
    switch (call.fn) {
      case "createIntent": {
        return outcome(() =>
          createComposerUploadIntent({ ...call.input, env })
        );
      }

      case "finalize": {
        return outcome(() => finalizeComposerUpload({ ...call.input, env }));
      }

      case "load": {
        return outcome(() => loadComposerUpload({ ...call.input, env }));
      }

      case "loadMetadata": {
        return outcome(() =>
          loadComposerUploadMetadata({ ...call.input, env })
        );
      }

      case "discard": {
        return outcome(() => discardComposerUploads({ ...call.input, env }));
      }

      case "store": {
        const body = call.stream
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(call.body);
                controller.close();
              },
            })
          : new Blob([call.body], { type: call.input.contentType });

        return outcome(() =>
          storeComposerUploadContent({ ...call.input, env, body })
        );
      }

      default: {
        const unexpected: never = call;
        throw new Error(`Unknown uploads call ${JSON.stringify(unexpected)}`);
      }
    }
  },

  /**
   * Finalizes while the bucket's deletes wait: the upload, what was deferred,
   * and the upload as loaded meanwhile; then lets the deletes through.
   */
  "mailFlow.uploads.finalizeWithBlockedCleanup": async (
    { env },
    input: { mailboxId: string; userId: string; uploadId: string }
  ) => {
    const deletes = gate();
    const { tasks, defer } = deferrals();

    const storage = bucketWith(env.MAIL_STORAGE, {
      delete: async (keys) => {
        await deletes.opened;

        return env.MAIL_STORAGE.delete(keys);
      },
    });

    try {
      const upload = await finalizeComposerUpload({
        ...input,
        env: { ...env, MAIL_STORAGE: storage },
        defer,
      });

      const deferred = tasks.length;
      const loaded = await loadComposerUpload({ ...input, env });

      return { upload, deferred, loaded };
    } finally {
      deletes.release();
      await Promise.all(tasks);
    }
  },

  /**
   * Two finalizers of one upload, interleaved: the first holds after reading
   * the metadata until the second has read it too, and the second reads the
   * staging object only after the first is done. Both results, and the
   * upload as loaded afterwards.
   */
  "mailFlow.uploads.finalizeRace": async (
    { env },
    input: {
      mailboxId: string;
      userId: string;
      uploadId: string;
      stagingKey: string;
      metadataKey: string;
    }
  ) => {
    const { stagingKey, metadataKey, ...ids } = input;
    const secondMetadataRead = gate();
    const secondStagingRead = gate();

    const first = bucketWith(env.MAIL_STORAGE, {
      get: async (key: string, options?: R2GetOptions) => {
        const object = await env.MAIL_STORAGE.get(key, options);

        if (key === metadataKey) await secondMetadataRead.opened;

        return object;
      },
    });

    const second = bucketWith(env.MAIL_STORAGE, {
      get: async (key: string, options?: R2GetOptions) => {
        if (key === stagingKey) await secondStagingRead.opened;
        const object = await env.MAIL_STORAGE.get(key, options);

        if (key === metadataKey) secondMetadataRead.release();

        return object;
      },
    });

    try {
      const firstRun = finalizeComposerUpload({
        ...ids,
        env: { ...env, MAIL_STORAGE: first },
      });

      const secondRun = outcome(() =>
        finalizeComposerUpload({
          ...ids,
          env: { ...env, MAIL_STORAGE: second },
        })
      );

      const firstResult = await firstRun;
      secondStagingRead.release();

      return {
        first: firstResult,
        second: await secondRun,
        loaded: await loadComposerUpload({ ...ids, env }),
      };
    } finally {
      secondMetadataRead.release();
      secondStagingRead.release();
    }
  },

  /**
   * prepareOutgoingEmail on the real bindings, or with a bucket whose puts
   * fail for keys ending in `failPutSuffix`. The prepared message's preview
   * and storage keys, or the error.
   */
  "mailFlow.outbound.prepare": (
    { env },
    input: Omit<Parameters<typeof prepareOutgoingEmail>[0], "env">,
    options: { failPutSuffix?: string } = {}
  ) => {
    const { failPutSuffix } = options;

    const storage = failPutSuffix
      ? bucketWith(env.MAIL_STORAGE, {
          put: (
            key: string,
            value: Parameters<R2Bucket["put"]>[1],
            putOptions?: R2PutOptions
          ) => {
            if (key.endsWith(failPutSuffix)) {
              return Promise.reject(new Error("Simulated HTML write failure"));
            }

            return env.MAIL_STORAGE.put(key, value, putOptions);
          },
        })
      : env.MAIL_STORAGE;

    return outcome(async () => {
      const prepared = await prepareOutgoingEmail({
        ...input,
        env: { ...env, MAIL_STORAGE: storage },
      });

      return {
        preview: prepared.email.preview,
        storageKeys: prepared.storageKeys,
      };
    });
  },

  "mailFlow.outbound.discardPrepared": ({ env }, storageKeys: string[]) =>
    discardPreparedObjects(env, storageKeys),

  /**
   * submitOutgoing while the bucket's deletes (composer cleanup) wait: whether
   * it returned within `timeoutMs`, what it deferred, and what a replay of
   * the same submission returns and defers. Then lets the deletes through and
   * removes the stored message objects.
   */
  "mailFlow.outbound.submitWithBlockedCleanup": async (
    { env },
    input: Omit<Parameters<typeof submitOutgoing>[0], "env" | "defer">,
    timeoutMs: number
  ) => {
    const deletes = gate();
    const { tasks, defer } = deferrals();

    const blockingEnv: Env = {
      ...env,
      MAIL_STORAGE: bucketWith(env.MAIL_STORAGE, {
        delete: async (keys) => {
          await deletes.opened;
          await env.MAIL_STORAGE.delete(keys);
        },
      }),
    };

    const submission = submitOutgoing({ ...input, env: blockingEnv, defer });
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const raced = await Promise.race([
        submission.then(() => "returned" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ]);

      const deferredFirst = tasks.length;

      const replay =
        raced === "returned"
          ? await submitOutgoing({ ...input, env: blockingEnv, defer })
          : null;

      return {
        raced,
        deferredFirst,
        replayInserted: replay?.inserted,
        deferredAfterReplay: tasks.length,
      };
    } finally {
      if (timer) clearTimeout(timer);
      deletes.release();
      await Promise.all(tasks);
      const result = await submission;
      await env.MAIL_STORAGE.delete([
        ...result.email.attachmentsJson.map((file) => file.r2Key),
        ...(result.email.bodyHtmlR2Key ? [result.email.bodyHtmlR2Key] : []),
      ]);
    }
  },

  /**
   * deferEmailSentWebhook for a submitted and an unconfirmed message, with a
   * webhooks queue that always fails: how many tasks were deferred, how the
   * first one settled, and how often the queue was tried.
   */
  "mailFlow.webhooks.emailSentWithFailingQueue": async ({ env }) => {
    let sends = 0;

    const failing: Env = {
      ...env,
      WEBHOOKS: fakeQueue(() => {
        sends += 1;
        throw new Error("Queue unavailable");
      }),
    };

    const { tasks, defer } = deferrals();
    const timelineAt = new Date("2026-08-24T12:00:00.000Z");
    deferEmailSentWebhook({
      env: failing,
      mailboxId: "mbx_webhook_state",
      email: { id: "msg_submitted", timelineAt, transportState: "submitted" },
      defer,
    });
    deferEmailSentWebhook({
      env: failing,
      mailboxId: "mbx_webhook_state",
      email: {
        id: "msg_unconfirmed",
        timelineAt,
        transportState: "unconfirmed",
      },
      defer,
    });
    const deferred = tasks.length;
    const [first] = tasks;

    const settled = await outcome(() =>
      required(first, "deferEmailSentWebhook deferred a task")
    );

    return { deferred, settled, sends };
  },

  /**
   * consumeWebhooks on one dispatch job, with a webhooks queue that records
   * the delivery jobs it is sent instead of delivering them (the live
   * consumer would otherwise race the test's own delivery).
   */
  "mailFlow.webhooks.dispatch": async ({ env }, body: WebhookDispatchJob) => {
    const sent: WebhookDeliveryJob[][] = [];

    const recording: Env = {
      ...env,
      WEBHOOKS: fakeQueue<WebhookDeliveryJob>((messages) =>
        sent.push(messages.map((message) => message.body))
      ),
    };

    const outcomeOf = { ack: 0, retry: 0 };

    const batch = messageBatch(
      "openworkspace-webhooks",
      [
        queueMessage(body, 1, {
          ack: () => void (outcomeOf.ack += 1),
          retry: () => void (outcomeOf.retry += 1),
        }),
      ],
      {
        ackAll: () => void (outcomeOf.ack += 1),
        retryAll: () => void (outcomeOf.retry += 1),
      }
    );

    await consumeWebhooks(batch, recording);

    return { ...outcomeOf, sent };
  },

  "mailFlow.workspaceFeedbackSummary": (
    { env },
    mailboxId: string,
    address: string
  ) => workspaceFeedbackSummary(env.DB, mailboxId, address),
} satisfies Record<string, TestHook>;
