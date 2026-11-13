import {
  createDb,
  mailboxes,
  hashToken,
  apiError,
} from "@open-workspace/core/module";
import type { AppEnv } from "@open-workspace/core/module";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { mailboxStub } from "../mailbox";

export const mailDownloadRoutes = new Hono<AppEnv>().get(
  "/mail/:token",
  async (c) => {
    const token = c.req.param("token");

    const [mailboxId, messageId, attachmentId, secret, ...extra] =
      token.split(".");

    if (!mailboxId || !messageId || !attachmentId || !secret || extra.length) {
      return apiError(
        c,
        404,
        "NOT_FOUND",
        "Download link is invalid or expired"
      );
    }

    // Check D1 first so an arbitrary public token cannot instantiate new DOs.
    const [mailbox] = await createDb(c.env.DB)
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.id, mailboxId))
      .limit(1);

    if (!mailbox) {
      return apiError(
        c,
        404,
        "NOT_FOUND",
        "Download link is invalid or expired"
      );
    }

    const file = await mailboxStub(c.env, mailboxId).getAttachment(
      messageId,
      attachmentId
    );

    const valid =
      file?.delivery === "download_link" &&
      file.downloadExpiresAt !== null &&
      file.downloadExpiresAt > Date.now() &&
      file.downloadTokenHash !== null &&
      file.downloadTokenHash === (await hashToken(token));

    if (!file || !valid) {
      return apiError(
        c,
        404,
        "NOT_FOUND",
        "Download link is invalid or expired"
      );
    }

    const object = await c.env.MAIL_STORAGE.get(file.r2Key);

    if (!object) {
      return apiError(c, 404, "NOT_FOUND", "Attachment data is missing");
    }

    return new Response(object.body, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": file.contentType,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        "x-content-type-options": "nosniff",
      },
    });
  }
);
