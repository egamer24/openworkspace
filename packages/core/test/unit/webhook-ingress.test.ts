import { describe, expect, it, mock } from "bun:test";

import {
  deferWebhookTask,
  queueWebhookEvent,
} from "../../worker/webhooks/service.ts";
import type { WebhookDispatchJob } from "../../worker/webhooks/service.ts";

// Only the webhooks queue's `send` is used, and it is a fake here.
describe("webhook queue ingress", () => {
  it("keeps one event ID across queue ingress retries", async () => {
    const jobs: WebhookDispatchJob[] = [];

    const sent: QueueSendResponse = {
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    };

    const send = mock((job: WebhookDispatchJob) => {
      jobs.push(job);

      return jobs.length < 3
        ? Promise.reject(new Error("Queue unavailable"))
        : Promise.resolve(sent);
    });

    const webhooks: Pick<Env["WEBHOOKS"], "send"> = { send };
    // SAFETY: queueWebhookEvent uses only env.WEBHOOKS.send.
    const env = { WEBHOOKS: webhooks } as Env;

    const deferred: Promise<unknown>[] = [];
    deferWebhookTask(
      (task) => deferred.push(task),
      (eventId) =>
        queueWebhookEvent(env, {
          eventId,
          eventType: "user.updated",
          occurredAt: 1,
          source: { kind: "data", data: { user: { id: "usr_retry" } } },
        })
    );

    await expect(deferred[0]).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(3);
    expect(new Set(jobs.map((job) => job.eventId)).size).toBe(1);
  });
});
