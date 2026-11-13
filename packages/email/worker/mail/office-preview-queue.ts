import { z } from "zod";

import { officePreviewExtension } from "../../shared/office-preview";
import { mailboxStub } from "../mailbox";

const jobSchema = z.object({
  mailboxId: z.string().min(1),
  messageId: z.string().min(1),
  attachmentId: z.string().min(1),
  sourceKey: z.string().min(1),
});

export async function consumeOfficePreviews(
  batch: MessageBatch<unknown>,
  env: Env
) {
  // Each job converts its own attachment, in its own container.
  await Promise.all(
    batch.messages.map((message) => processOfficePreview(message, env))
  );
}

async function processOfficePreview(message: Message<unknown>, env: Env) {
  const parsed = jobSchema.safeParse(message.body);

  if (!parsed.success) {
    message.ack();

    return;
  }

  const job = parsed.data;
  const mailbox = mailboxStub(env, job.mailboxId);

  try {
    const file = await mailbox.getAttachment(job.messageId, job.attachmentId);

    if (!file || file.r2Key !== job.sourceKey) {
      // A previous attempt may have produced a PDF after the email was deleted.
      await mailbox.completeOfficePreview(
        job.messageId,
        job.attachmentId,
        job.sourceKey,
        "failed"
      );
      message.ack();

      return;
    }

    if (file.pdfPreviewStatus !== "pending") {
      message.ack();

      return;
    }

    const extension = officePreviewExtension(file.filename);

    const status = extension
      ? await env.OFFICE_PREVIEW_CONTAINER.getByName(job.sourceKey).convert(
          job.sourceKey,
          extension
        )
      : "failed";

    await mailbox.completeOfficePreview(
      job.messageId,
      job.attachmentId,
      job.sourceKey,
      status
    );
    message.ack();
  } catch (error) {
    console.error("Could not generate Office preview", {
      messageId: job.messageId,
      error,
    });

    if (message.attempts < 3) {
      message.retry({ delaySeconds: 30 * message.attempts });

      return;
    }

    await mailbox.completeOfficePreview(
      job.messageId,
      job.attachmentId,
      job.sourceKey,
      "failed"
    );
    message.ack();
  }
}
