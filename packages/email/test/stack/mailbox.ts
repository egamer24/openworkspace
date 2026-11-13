import type { AiModel } from "@open-workspace/core/module";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";

import { MailboxDO as EmailMailboxDO } from "../../index.ts";

/**
 * Stand-ins a stack test installs on one mailbox (`testFake`). They live in the
 * object's storage, so they hold for whichever instance runs, including
 * alarms that fire on their own; `testCalls` reports what they saw.
 */
export type MailboxFakes = {
  /** Office preview jobs are recorded instead of queued, or the queue is down. */
  officePreviews?: "capture" | "fail";
  /** Push jobs (new mail, JMAP state) are recorded instead of queued. */
  push?: "capture";
  /** Webhook events are recorded instead of queued. */
  webhooks?: "capture";
  /** Writes or deletes in the mail bucket fail; reads still work. */
  mailStorage?: { put?: "fail"; delete?: "fail" };
  /**
   * The classification model: `rules` answers with the text of the first
   * rule whose `includes` is in the prompt (else `fallback`), `unavailable`
   * is a model whose calls fail, and `throw` fails before any model exists.
   */
  classifier?:
    | {
        mode: "rules";
        reasoning?: AiModel["reasoning"];
        rules: { includes: string; text: string }[];
        fallback: string;
      }
    | { mode: "unavailable" }
    | { mode: "throw" };
};

/** The queues a mailbox's fakes stand in front of. */
type FakedQueue = "OFFICE_PREVIEWS" | "PUSH_NOTIFICATIONS" | "WEBHOOKS";

/** What a fake saw: queue sends, bucket writes, model calls, console errors during alarms. */
export type MailboxCall =
  | { kind: "console.error"; data: string[] }
  | { kind: "classificationModel"; data: null }
  | {
      kind: "doGenerate";
      data: { reasoning: AiModel["reasoning"]; prompt: string };
    }
  | { kind: "MAIL_STORAGE.put"; data: string }
  | { kind: "MAIL_STORAGE.delete"; data: string | string[] }
  // The bindings are `Queue<unknown>`: a body is whatever the module sent.
  | { kind: `${FakedQueue}.send`; data: unknown }
  | { kind: `${FakedQueue}.sendBatch`; data: unknown[] };

/** The test stack's own binding: the test process's URL; only a test deployment has it. */
const testStackEnv = z.object({ TEST_HOOKS: z.string().optional() });

const NO_BACKLOG: QueueMetrics = { backlogCount: 0, backlogBytes: 0 };

const FAKES_KEY = "test:fakes";
const CALLS_KEY = "test:calls";

/**
 * The email module's mailbox Durable Object with test-only RPC methods the
 * stack suite reaches through `/api/__test/mailbox/:id` (worker.ts).
 * The routes exist only in a test deployment, so nothing calls these
 * elsewhere, and the fakes apply only in one.
 */
export class MailboxDO extends EmailMailboxDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    if (testStackEnv.parse(env).TEST_HOOKS) {
      Reflect.set(this, "bindings", this.testBindings(env));
    }
  }

  /** Runs a scheduled alarm now, as `runDurableObjectAlarm` did; false when none was set. */
  async testRunAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) return false;
    await this.ctx.storage.deleteAlarm();
    await this.alarm();

    return true;
  }

  /** When the alarm is set for, or null. */
  testAlarm() {
    return this.ctx.storage.getAlarm();
  }

  /** Rows of a query against this mailbox's own SQLite storage. */
  testSql(query: string, ...params: unknown[]) {
    return this.ctx.storage.sql.exec(query, ...params).toArray();
  }

  /**
   * Makes this object look like one whose last inbox counts write to D1
   * did not land: forgets which counts D1 has and restarts (the call itself fails).
   */
  async testForgetInboxCounts() {
    this.ctx.storage.kv.delete("inboxCountsVersion");
    await this.ctx.storage.sync();
    this.ctx.abort("Restarting as a mailbox whose counts write did not land");
  }

  /** Installs (replaces) this mailbox's fakes; `{}` removes them. */
  testFake(fakes: MailboxFakes) {
    this.ctx.storage.kv.put(FAKES_KEY, fakes);
  }

  /** What the fakes saw, oldest first. */
  testCalls(): MailboxCall[] {
    return this.ctx.storage.kv.get<MailboxCall[]>(CALLS_KEY) ?? [];
  }

  override async alarm() {
    // Console errors are part of what some tests assert; count them per mailbox.
    if (
      !this.fakes().classifier &&
      !this.fakes().mailStorage &&
      !this.fakes().officePreviews
    ) {
      return super.alarm();
    }

    const { error } = console;
    console.error = (...args: unknown[]) =>
      this.record({ kind: "console.error", data: args.map(String) });

    try {
      await super.alarm();
    } finally {
      console.error = error;
    }
  }

  protected override classificationModel(): Promise<AiModel | null> {
    const fake = this.fakes().classifier;

    if (!fake) return super.classificationModel();
    this.record({ kind: "classificationModel", data: null });

    if (fake.mode === "throw") {
      return Promise.reject(
        new Error("AI must not run before MIME storage completes")
      );
    }

    const model = new MockLanguageModelV4({
      doGenerate: (options) => {
        this.record({
          kind: "doGenerate",
          data: {
            reasoning: options.reasoning,
            prompt: JSON.stringify(options.prompt),
          },
        });

        if (fake.mode === "unavailable") {
          return Promise.reject(
            new Error("The model is deliberately unavailable")
          );
        }

        const prompt = JSON.stringify(options.prompt);

        const text =
          fake.rules.find((rule) => prompt.includes(rule.includes))?.text ??
          fake.fallback;

        return Promise.resolve({
          content: [{ type: "text", text }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        });
      },
    });

    return Promise.resolve(
      fake.mode === "unavailable"
        ? { id: "mock/unavailable", model, reasoning: undefined }
        : { id: "mock/classifier", model, reasoning: fake.reasoning }
    );
  }

  private fakes(): MailboxFakes {
    return this.ctx.storage.kv.get<MailboxFakes>(FAKES_KEY) ?? {};
  }

  private record(call: MailboxCall) {
    this.ctx.storage.kv.put(CALLS_KEY, [...this.testCalls(), call]);
  }

  /** The Worker's bindings, with this mailbox's fakes in front of the queues and bucket. */
  private testBindings(env: Env): Env {
    /** What a faked send does: records the body, then fails when the queue is down. */
    const captured = <Sent>(
      call: MailboxCall,
      mode: "capture" | "fail",
      response: Sent
    ) =>
      new Promise<Sent>((resolve, reject) => {
        this.record(call);

        if (mode === "fail") reject(new Error("Queue unavailable"));
        else resolve(response);
      });

    const queue = (
      name: FakedQueue,
      mode: () => "capture" | "fail" | undefined,
      real: Queue
    ): Queue => ({
      metrics: () => real.metrics(),
      send: (body, options) => {
        const faked = mode();

        if (!faked) return real.send(body, options);

        return captured({ kind: `${name}.send`, data: body }, faked, {
          metadata: { metrics: NO_BACKLOG },
        });
      },
      sendBatch: (messages, options) => {
        const faked = mode();

        if (!faked) return real.sendBatch(messages, options);

        return captured(
          {
            kind: `${name}.sendBatch`,
            data: Array.from(messages, (message) => message.body),
          },
          faked,
          { metadata: { metrics: NO_BACKLOG } }
        );
      },
    });

    const real = env.MAIL_STORAGE;

    const bucket: R2Bucket = {
      head: (key) => real.head(key),
      get: (key: string, options?: R2GetOptions) => real.get(key, options),
      put: (
        key: string,
        value: Parameters<R2Bucket["put"]>[1],
        options?: R2PutOptions
      ) => {
        if (this.fakes().mailStorage?.put === "fail") {
          this.record({ kind: "MAIL_STORAGE.put", data: key });

          return Promise.reject(new Error("R2 write failed"));
        }

        return real.put(key, value, options);
      },
      createMultipartUpload: (key, options) =>
        real.createMultipartUpload(key, options),
      resumeMultipartUpload: (key, uploadId) =>
        real.resumeMultipartUpload(key, uploadId),
      delete: (keys) => {
        if (this.fakes().mailStorage?.delete === "fail") {
          this.record({ kind: "MAIL_STORAGE.delete", data: keys });

          return Promise.reject(new Error("R2 unavailable"));
        }

        return real.delete(keys);
      },
      list: (options) => real.list(options),
    };

    return {
      ...env,
      OFFICE_PREVIEWS: queue(
        "OFFICE_PREVIEWS",
        () => this.fakes().officePreviews,
        env.OFFICE_PREVIEWS
      ),
      PUSH_NOTIFICATIONS: queue(
        "PUSH_NOTIFICATIONS",
        () => this.fakes().push,
        env.PUSH_NOTIFICATIONS
      ),
      WEBHOOKS: queue("WEBHOOKS", () => this.fakes().webhooks, env.WEBHOOKS),
      MAIL_STORAGE: bucket,
    };
  }
}
