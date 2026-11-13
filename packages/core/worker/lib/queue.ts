import type { z } from "zod";

/** A queue batch takes at most 100 messages. */
const MAX_BATCH_MESSAGES = 100;

/** Sends `bodies` to `queue`, as many batches as it takes. */
export async function sendInBatches<Body>(
  queue: Queue<Body>,
  bodies: readonly Body[]
) {
  const batches: MessageSendRequest<Body>[][] = [];

  for (let start = 0; start < bodies.length; start += MAX_BATCH_MESSAGES) {
    batches.push(
      bodies.slice(start, start + MAX_BATCH_MESSAGES).map((body) => ({ body }))
    );
  }

  await Promise.all(batches.map((batch) => queue.sendBatch(batch)));
}

type JobQueueOptions<Job> = {
  queueName: string;
  schema: z.ZodType<Job>;
  run: (job: Job, attempts: number) => Promise<void>;
  /** Whether a failed job is done with: acknowledged instead of retried. */
  settled?: (job: Job, cause: unknown, attempts: number) => Promise<boolean>;
  retryBaseSeconds: number;
};

async function consumeMessage<Job>(
  message: Message,
  options: JobQueueOptions<Job>
) {
  const parsed = options.schema.safeParse(message.body);

  if (!parsed.success) {
    console.error(`Ignoring invalid ${options.queueName} job`, parsed.error);
    message.ack();

    return;
  }

  try {
    await options.run(parsed.data, message.attempts);
    message.ack();
  } catch (error) {
    console.error(`Could not run ${options.queueName} job`, error);

    if (await options.settled?.(parsed.data, error, message.attempts)) {
      message.ack();

      return;
    }

    message.retry({
      delaySeconds: Math.min(
        3600,
        options.retryBaseSeconds * 2 ** Math.max(0, message.attempts - 1)
      ),
    });
  }
}

/**
 * Runs a queue batch's jobs one at a time, in the order they arrived. A
 * message that isn't a job is dropped; a failed job is retried with
 * exponential backoff from `retryBaseSeconds`, unless `settled` says it is
 * done with.
 */
export async function consumeInOrder<Job>(
  batch: MessageBatch,
  options: JobQueueOptions<Job>
) {
  for (const message of batch.messages) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- jobs run one at a time: a sync re-runs a connection queued twice, and a delivery holds a whole email in memory
    await consumeMessage(message, options);
  }
}
