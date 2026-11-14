import {
  apiError,
  can,
  createDb,
  mailboxAddressSql,
  mailboxes,
  oauthScope,
  zValidator,
} from "@open-workspace/core/module";
import type { AppEnv } from "@open-workspace/core/module";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { MAIL_ORGANIZE_SCOPE, MAIL_READ_SCOPE } from "../../shared/permissions";
import { mailboxStub } from "../mailbox";
import type { AutoReplyMessage, AutoReplySettings } from "../mailbox/schema";
import { autoReplyImagePrefix, autoReplyStatus } from "./auto-reply";
import {
  deleteRichImages,
  isEmptyRichContent,
  storeRichImages,
} from "./rich-content";
import { autoReplySchema } from "./schemas";
import { UploadValidationError } from "./uploads";

/**
 * Who may see and change an address's auto-reply: its owner for their own
 * mailbox (Settings), people who manage people for anyone's (People), and
 * people who manage teams for a team inbox (Teams). Only addresses with a
 * mailbox of their own have one: mail to an alias is answered by its
 * target's, and a mailing list's goes straight to its members.
 */
async function autoReplyAccess(c: Context<AppEnv>, mailboxId: string) {
  const [mailbox] = await createDb(c.env.DB)
    .select({ ownerUserId: mailboxes.ownerUserId })
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.delivery, "inbox")))
    .limit(1);

  if (!mailbox) return "not found";

  const allowed =
    mailbox.ownerUserId === null
      ? can(c, "manage_teams")
      : mailbox.ownerUserId === c.get("user").id || can(c, "manage_people");

  return allowed ? "allowed" : "forbidden";
}

function refusal(c: Context<AppEnv>, access: "not found" | "forbidden") {
  return access === "not found"
    ? apiError(c, 404, "NOT_FOUND", "Mailbox not found")
    : apiError(
        c,
        403,
        "FORBIDDEN",
        "You can't change this mailbox's auto-reply"
      );
}

function messageView({ text: _text, ...message }: AutoReplyMessage) {
  return message;
}

function autoReplyView(mailboxId: string, settings: AutoReplySettings | null) {
  return {
    ok: true as const,
    /** Saved images are shown from `/auto-reply/images/:contentId` of this mailbox. */
    ownerId: mailboxId,
    status: autoReplyStatus(settings, new Date()),
    settings: settings && {
      enabled: settings.enabled,
      startsAt: settings.startsAt,
      endsAt: settings.endsAt,
      replyIntervalDays: settings.replyIntervalDays,
      inside: messageView(settings.inside),
      outside: {
        ...messageView(settings.outside),
        audience: settings.outside.audience,
      },
      updatedAt: settings.updatedAt,
    },
  };
}

/**
 * Mailboxes' auto-replies (mailbox/index.ts sends them). Mounted under
 * /mail. Messages are rich content (rich-content.ts) whose images live under
 * the mailbox's own objects, so they go when it does.
 */
export const autoReplyRoutes = new Hono<AppEnv>()
  // Settings → Auto-reply: the signed-in person's own mailboxes.
  .get("/auto-replies", oauthScope(MAIL_READ_SCOPE), async (c) => {
    const rows = await createDb(c.env.DB)
      .select({
        id: mailboxes.id,
        address: mailboxAddressSql,
        displayName: mailboxes.displayName,
      })
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.ownerUserId, c.get("user").id),
          eq(mailboxes.delivery, "inbox")
        )
      )
      .orderBy(desc(mailboxes.isPrimary), mailboxes.displayName);

    return c.json({ ok: true as const, mailboxes: rows });
  })
  .get("/mailboxes/:id/auto-reply", oauthScope(MAIL_READ_SCOPE), async (c) => {
    const mailboxId = c.req.param("id");
    const access = await autoReplyAccess(c, mailboxId);

    if (access !== "allowed") return refusal(c, access);

    return c.json(
      autoReplyView(
        mailboxId,
        await mailboxStub(c.env, mailboxId).getAutoReply()
      )
    );
  })
  .put(
    "/mailboxes/:id/auto-reply",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    zValidator("json", autoReplySchema),
    async (c) => {
      const mailboxId = c.req.param("id");
      const access = await autoReplyAccess(c, mailboxId);

      if (access !== "allowed") return refusal(c, access);
      const input = c.req.valid("json");

      if (input.enabled && !input.inside.enabled && !input.outside.enabled) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          "Turn on the message for people inside or outside the workspace"
        );
      }

      for (const [message, who] of [
        [input.inside, "inside"],
        [input.outside, "outside"],
      ] as const) {
        if (message.enabled && isEmptyRichContent(message)) {
          return apiError(
            c,
            400,
            "BAD_REQUEST",
            `Write the message for people ${who} the workspace`
          );
        }
      }

      const stub = mailboxStub(c.env, mailboxId);
      const previous = await stub.getAutoReply();
      const prefix = autoReplyImagePrefix(mailboxId);

      // One folder for both messages, so an image can move between them.
      const previousImages = previous
        ? [...previous.inside.images, ...previous.outside.images]
        : [];

      let images;

      try {
        images = await Promise.all(
          [input.inside, input.outside].map((content) =>
            storeRichImages({
              env: c.env,
              userId: c.get("user").id,
              prefix,
              previous: previousImages,
              content,
            })
          )
        );
      } catch (error) {
        if (error instanceof UploadValidationError) {
          return apiError(c, 400, "BAD_REQUEST", error.message);
        }

        throw error;
      }

      const [insideImages = [], outsideImages = []] = images;

      const message = (
        content: typeof input.inside,
        stored: typeof insideImages
      ) => ({
        enabled: content.enabled,
        subject: content.subject,
        html: content.html,
        text: content.text,
        images: stored,
      });

      const saved = await stub.setAutoReply(
        {
          enabled: input.enabled,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          replyIntervalDays: input.replyIntervalDays,
          inside: message(input.inside, insideImages),
          outside: {
            ...message(input.outside, outsideImages),
            audience: input.outside.audience,
          },
        },
        c.get("user").id
      );

      await deleteRichImages(
        c.env.MAIL_STORAGE,
        prefix,
        new Set(
          [...insideImages, ...outsideImages].map((image) => image.contentId)
        )
      );

      return c.json(autoReplyView(mailboxId, saved));
    }
  )
  // The banner in Mail turns it off without sending the messages back.
  .patch(
    "/mailboxes/:id/auto-reply",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    zValidator("json", z.object({ enabled: z.literal(false) })),
    async (c) => {
      const mailboxId = c.req.param("id");
      const access = await autoReplyAccess(c, mailboxId);

      if (access !== "allowed") return refusal(c, access);

      return c.json(
        autoReplyView(
          mailboxId,
          await mailboxStub(c.env, mailboxId).turnOffAutoReply(c.get("user").id)
        )
      );
    }
  )
  .get(
    "/mailboxes/:id/auto-reply/images/:contentId",
    oauthScope(MAIL_READ_SCOPE),
    async (c) => {
      const { id: mailboxId, contentId } = c.req.param();
      const access = await autoReplyAccess(c, mailboxId);

      const object =
        access === "allowed"
          ? await c.env.MAIL_STORAGE.get(
              `${autoReplyImagePrefix(mailboxId)}${contentId}`
            )
          : null;

      if (!object) return apiError(c, 404, "NOT_FOUND", "Image not found");

      return new Response(object.body, {
        headers: {
          "content-type":
            object.httpMetadata?.contentType ?? "application/octet-stream",
          "cache-control": "private, max-age=300",
          "x-content-type-options": "nosniff",
        },
      });
    }
  );
