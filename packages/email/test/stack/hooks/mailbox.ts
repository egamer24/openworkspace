import type { TestHook } from "@open-workspace/core/testing/worker";
import { resolveBimi } from "@open-workspace/email/worker/mail/bimi.ts";
import type {
  DnsAnswer,
  DnsResolver,
} from "@open-workspace/email/worker/mail/doh.ts";
import { withSenderIntel } from "@open-workspace/email/worker/mail/header-metadata.ts";
import { convertOfficeDocument } from "@open-workspace/email/worker/mail/office-conversion.ts";
import { consumeOfficePreviews } from "@open-workspace/email/worker/mail/office-preview-queue.ts";
import { collectSenderIntel } from "@open-workspace/email/worker/mail/sender-intel.ts";
import { mailboxStub } from "@open-workspace/email/worker/mailbox/index.ts";

import { emailQueueRoles } from "../../../shared/module.ts";
import type { OfficePreviewJob } from "../../../shared/office-preview.ts";
import { messageBatch, queueMessage, queueName } from "./fakes.ts";

/** A resolver answering from `"TYPE name" -> records`; NXDOMAIN otherwise. It logs its queries. */
function tableResolver(table: Record<string, string[]>) {
  const queries: string[] = [];

  const resolve: DnsResolver = (name, type) => {
    queries.push(`${type} ${name}`);
    const records = table[`${type} ${name}`];

    const answer: DnsAnswer = records
      ? { status: "ok", records }
      : { status: "nxdomain", records: [] };

    return Promise.resolve(answer);
  };

  return { resolve, queries };
}

/** Test hooks for the mailbox, Office preview, and sender intelligence stack tests (see index.ts). */
export const hooks = {
  /** Fills in sender intelligence for a stored email on view, with the mailbox's real stub. */
  "mailbox.withSenderIntel": async (
    { env },
    mailboxId: string,
    emailId: string,
    context: Parameters<typeof withSenderIntel>[3]
  ) => {
    const mailbox = mailboxStub(env, mailboxId);
    const email = await mailbox.getEmail(emailId);

    if (!email) throw new Error(`No email ${emailId}`);

    return withSenderIntel(env, mailbox, email, context);
  },

  /**
   * The BIMI logo lookup against the Worker's mail bucket, with DNS from a
   * table; logos are fetched over the Worker's outgoing fetch (the test
   * process answers), or never when `fetch` is false.
   */
  "mailbox.resolveBimi": async (
    { env },
    input: {
      table: Record<string, string[]>;
      fromDomain: string;
      orgDomain: string;
      now?: number;
      fetch?: boolean;
    }
  ) => {
    const { resolve, queries } = tableResolver(input.table);

    const result = await resolveBimi({
      resolve,
      fetch:
        input.fetch === false
          ? Object.assign(() => Promise.reject(new Error("must not fetch")), {
              preconnect: fetch.preconnect,
            })
          : fetch,
      bucket: env.MAIL_STORAGE,
      fromDomain: input.fromDomain,
      orgDomain: input.orgDomain,
      now: input.now,
    });

    return { result, queries };
  },

  /** Sender intelligence with DNS from a table and the Worker's mail bucket. */
  "mailbox.collectSenderIntel": async (
    { env },
    input: Omit<
      Parameters<typeof collectSenderIntel>[0],
      "bucket" | "resolver" | "fetch"
    > & { table: Record<string, string[]> }
  ) => {
    const { table, ...rest } = input;
    const { resolve, queries } = tableResolver(table);

    const intel = await collectSenderIntel({
      ...rest,
      bucket: env.MAIL_STORAGE,
      resolver: resolve,
    });

    return { intel, queries };
  },

  /**
   * The Office preview consumer with a converter that cannot start, as
   * without a container; reports each message's ack or retry.
   */
  "mailbox.consumeOfficePreviewsWithoutContainer": async (
    { env },
    messages: { body: OfficePreviewJob; attempts: number }[]
  ) => {
    const outcomes: { ack: boolean; retry?: QueueRetryOptions }[] = [];

    const batch = messageBatch(
      queueName(env, emailQueueRoles.officePreviews),
      messages.map((message) => {
        const outcome: (typeof outcomes)[number] = { ack: false };
        outcomes.push(outcome);

        return queueMessage(message.body, message.attempts, {
          ack: () => void (outcome.ack = true),
          retry: (options) => void (outcome.retry = options ?? {}),
        });
      })
    );

    type Container = Env["OFFICE_PREVIEW_CONTAINER"];

    const failingConverter = {
      convert: (
        sourceKey: string,
        extension: string
      ): Promise<"failed" | "ready"> =>
        Promise.reject(
          new Error(
            `Office preview container is not configured (${extension} ${sourceKey})`
          )
        ),
    };

    const container = env.OFFICE_PREVIEW_CONTAINER;

    // SAFETY: consumeOfficePreviews uses a container stub only as
    // `.convert(key, extension)`, which this stand-in answers by failing as
    // an unconfigured container does; nothing else of the stub is read.
    const failingStub = failingConverter as ReturnType<Container["getByName"]>;

    const unavailable: Container = {
      newUniqueId: container.newUniqueId.bind(container),
      idFromName: container.idFromName.bind(container),
      idFromString: container.idFromString.bind(container),
      get: () => failingStub,
      getByName: () => failingStub,
      jurisdiction: () => unavailable,
    };

    const { error } = console;
    console.error = () => {};

    try {
      await consumeOfficePreviews(batch, {
        ...env,
        OFFICE_PREVIEW_CONTAINER: unavailable,
      });
    } finally {
      console.error = error;
    }

    return outcomes;
  },

  /**
   * Converts an R2 object with a stand-in converter: `ok` answers a PDF and
   * reports the upload it received; `503`, `not-pdf` and `400` answer as
   * named. Errors come back as `{ error }`.
   */
  "mailbox.convertOfficeDocument": async (
    { env },
    key: string,
    converter: "ok" | "503" | "not-pdf" | "400"
  ) => {
    let upload:
      | { pathname: string; isFile: boolean; name?: string; text?: string }
      | undefined;

    const send = async (request: Request) => {
      if (converter === "503") return new Response("broken", { status: 503 });

      if (converter === "not-pdf") return new Response("not a PDF");

      if (converter === "400") {
        return new Response("password required", { status: 400 });
      }

      const file = (await request.formData()).get("files");
      upload = {
        pathname: new URL(request.url).pathname,
        isFile: file instanceof File,
      };

      if (file instanceof File) {
        upload.name = file.name;
        upload.text = await file.text();
      }

      return new Response("%PDF-1.7\nconverted", {
        headers: { "content-type": "application/pdf" },
      });
    };

    try {
      return {
        result: await convertOfficeDocument(
          env.MAIL_STORAGE,
          send,
          key,
          "xlsx"
        ),
        upload,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        upload,
      };
    }
  },
} satisfies Record<string, TestHook>;
