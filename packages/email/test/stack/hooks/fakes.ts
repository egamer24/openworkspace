import { required } from "@open-workspace/core/shared";
import { z } from "zod";

/**
 * Stand-ins for the Worker's bindings that hooks hand to module code: a
 * queue producer that records, a hand-made queue batch, a bucket with some
 * methods replaced. Each is the binding's full interface, so module code
 * sees the type it declares.
 */

const NO_BACKLOG: QueueMetrics = { backlogCount: 0, backlogBytes: 0 };

/** A queue producer whose sends go to `onSend` (one call per send or batch) instead of a queue. */
export function fakeQueue<Body>(
  onSend: (messages: MessageSendRequest<Body>[]) => void
): Queue<Body> {
  return {
    metrics: () => Promise.resolve(NO_BACKLOG),
    // In a promise, so a throwing `onSend` rejects the send as a failing queue does.
    send: (body) =>
      new Promise((resolve) => {
        onSend([{ body }]);
        resolve({ metadata: { metrics: NO_BACKLOG } });
      }),
    sendBatch: (messages) =>
      new Promise((resolve) => {
        onSend([...messages]);
        resolve({ metadata: { metrics: NO_BACKLOG } });
      }),
  };
}

/** What a consumer may do with one message of a hand-made batch. */
type MessageHandlers = {
  ack: () => void;
  retry: (options?: QueueRetryOptions) => void;
};

/** One queue message as a consumer receives it. */
export function queueMessage<Body>(
  body: Body,
  attempts: number,
  handlers: MessageHandlers
): Message<Body> {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts,
    ...handlers,
  };
}

/** A batch of `messages` from `queue`, as the queue handler receives it. */
export function messageBatch<Body>(
  queue: string,
  messages: Message<Body>[],
  all: { ackAll?: () => void; retryAll?: () => void } = {}
): MessageBatch<Body> {
  return {
    queue,
    messages,
    metadata: { metrics: NO_BACKLOG },
    ackAll: all.ackAll ?? (() => {}),
    retryAll: all.retryAll ?? (() => {}),
  };
}

const queueNamesSchema = z.record(z.string(), z.string());

/** The deployed name of the queue with this role (`QUEUE_NAMES`, a JSON map the stack binds). */
export function queueName(env: Env, role: string) {
  return required(
    queueNamesSchema.parse(JSON.parse(env.QUEUE_NAMES))[role],
    `QUEUE_NAMES names a queue for ${role}`
  );
}

/** The bucket with some of its methods replaced. */
export function bucketWith(
  bucket: R2Bucket,
  overrides: Partial<R2Bucket>
): R2Bucket {
  return {
    head: bucket.head.bind(bucket),
    get: bucket.get.bind(bucket),
    put: bucket.put.bind(bucket),
    createMultipartUpload: bucket.createMultipartUpload.bind(bucket),
    resumeMultipartUpload: bucket.resumeMultipartUpload.bind(bucket),
    delete: bucket.delete.bind(bucket),
    list: bucket.list.bind(bucket),
    ...overrides,
  };
}
