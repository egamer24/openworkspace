import {
  MAX_OFFICE_PREVIEW_BYTES,
  officePreviewExtension,
} from "../../shared/office-preview";
import type { OfficePreviewJob } from "../../shared/office-preview";
import type { NewEmail } from "./schema";

export function prepareOfficePreviews(email: NewEmail): NewEmail {
  return {
    ...email,
    attachmentsJson: email.attachmentsJson?.map((file) => ({
      ...file,
      pdfPreviewStatus: officePreviewExtension(file.filename)
        ? file.size <= MAX_OFFICE_PREVIEW_BYTES
          ? "pending"
          : "failed"
        : undefined,
    })),
  };
}

export function hasPendingOfficePreviews(email: NewEmail) {
  return (
    email.attachmentsJson?.some(
      (file) => file.pdfPreviewStatus === "pending"
    ) ?? false
  );
}

export function insertOfficePreviewJobs(sql: SqlStorage, email: NewEmail) {
  for (const file of email.attachmentsJson ?? []) {
    if (file.pdfPreviewStatus !== "pending") continue;
    // Runs on the same SQLite connection inside the email insert transaction.
    sql.exec(
      `insert into pending_office_previews
        (source_key, email_id, attachment_id, attempts, next_attempt_at)
        values (?, ?, ?, 0, ?) on conflict do nothing`,
      file.r2Key,
      email.id,
      file.id,
      Date.now()
    );
  }
}

export async function dispatchOfficePreviewJobs(
  sql: SqlStorage,
  env: Env,
  mailboxId: string
) {
  const jobs = sql
    .exec<{
      source_key: string;
      email_id: string;
      attachment_id: string;
      attempts: number;
    }>(
      "select * from pending_office_previews where next_attempt_at <= ? order by next_attempt_at limit 10",
      Date.now()
    )
    .toArray();

  if (!jobs.length) return;

  try {
    await env.OFFICE_PREVIEWS.sendBatch(
      jobs.map((job) => ({
        body: {
          mailboxId,
          messageId: job.email_id,
          attachmentId: job.attachment_id,
          sourceKey: job.source_key,
        } satisfies OfficePreviewJob,
      }))
    );

    for (const job of jobs) {
      sql.exec(
        "delete from pending_office_previews where source_key = ?",
        job.source_key
      );
    }
  } catch (error) {
    for (const job of jobs) {
      const delay = Math.min(3_600_000, 5000 * 2 ** Math.min(job.attempts, 10));

      sql.exec(
        "update pending_office_previews set attempts = attempts + 1, next_attempt_at = ? where source_key = ?",
        Date.now() + delay,
        job.source_key
      );
    }

    console.error("Could not queue Office previews", error);
  }
}

export function nextOfficePreviewAttempt(sql: SqlStorage) {
  return sql
    .exec<{ next_attempt_at: number }>(
      "select next_attempt_at from pending_office_previews order by next_attempt_at limit 1"
    )
    .toArray()[0]?.next_attempt_at;
}
