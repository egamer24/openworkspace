import {
  apiError,
  can,
  createDb,
  mailboxes,
  oauthScope,
  requirePermission,
  zValidator,
} from "@open-workspace/core/module";
import type { AppEnv } from "@open-workspace/core/module";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import type { z } from "zod";

import { MAIL_ORGANIZE_SCOPE, MAIL_READ_SCOPE } from "../../shared/permissions";
import { signatures } from "../db/schema";
import { accessibleMailbox } from "./access";
import {
  deleteRichImages,
  isEmptyRichContent,
  storeRichImages,
} from "./rich-content";
import { signatureSchema } from "./schemas";
import {
  loadSignature,
  ownerColumn,
  ownerId,
  signatureImagePrefix,
} from "./signatures";
import type { Signature, SignatureOwner } from "./signatures";
import { UploadValidationError } from "./uploads";

function signatureView(owner: SignatureOwner, signature: Signature | null) {
  return {
    ok: true as const,
    signature: signature && {
      ownerId: ownerId(owner),
      html: signature.html,
      images: signature.images,
      useOnNew: signature.useOnNew,
      useOnReply: signature.useOnReply,
    },
  };
}

/**
 * Saves the HTML as given (the editor's own output; recipients sanitize mail
 * on display), with its images stored under the owner's signature prefix
 * (rich-content.ts). Images no longer in the signature are deleted.
 */
async function saveSignature(
  c: Context<AppEnv>,
  owner: SignatureOwner,
  input: z.infer<typeof signatureSchema>
) {
  const prefix = signatureImagePrefix(ownerId(owner));
  const db = createDb(c.env.DB);

  if (isEmptyRichContent(input)) {
    await db.delete(signatures).where(ownerColumn(owner));
    await deleteRichImages(c.env.MAIL_STORAGE, prefix);

    return null;
  }

  const images = await storeRichImages({
    env: c.env,
    userId: c.get("user").id,
    prefix,
    previous: (await loadSignature(c.env, owner))?.images ?? [],
    content: input,
  });

  const signature = {
    html: input.html,
    text: input.text,
    images,
    useOnNew: input.useOnNew,
    useOnReply: input.useOnReply,
  };

  const values = { ...signature, updatedAt: new Date() };

  await db
    .insert(signatures)
    .values({ ...owner, ...values })
    .onConflictDoUpdate({
      target: "userId" in owner ? signatures.userId : signatures.mailboxId,
      set: values,
    });

  await deleteRichImages(
    c.env.MAIL_STORAGE,
    prefix,
    new Set(images.map((image) => image.contentId))
  );

  return signature;
}

async function saveResponse(
  c: Context<AppEnv>,
  owner: SignatureOwner,
  input: z.infer<typeof signatureSchema>
) {
  try {
    return c.json(signatureView(owner, await saveSignature(c, owner, input)));
  } catch (error) {
    if (error instanceof UploadValidationError) {
      return apiError(c, 400, "BAD_REQUEST", error.message);
    }

    throw error;
  }
}

async function isTeamAddress(env: Env, mailboxId: string) {
  const [row] = await createDb(env.DB)
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), isNull(mailboxes.ownerUserId)))
    .limit(1);

  return Boolean(row);
}

/**
 * The signed-in person's own signature, and team addresses' signatures for
 * people who manage teams (Administration → Teams). Mounted under /mail.
 */
export const signatureRoutes = new Hono<AppEnv>()
  .get("/signature", oauthScope(MAIL_READ_SCOPE), async (c) => {
    const owner = { userId: c.get("user").id };

    return c.json(signatureView(owner, await loadSignature(c.env, owner)));
  })
  .put(
    "/signature",
    oauthScope(MAIL_ORGANIZE_SCOPE),
    zValidator("json", signatureSchema),
    (c) => saveResponse(c, { userId: c.get("user").id }, c.req.valid("json"))
  )
  .get(
    "/team-signatures/:mailboxId",
    requirePermission("manage_teams"),
    async (c) => {
      const owner = { mailboxId: c.req.param("mailboxId") };

      if (!(await isTeamAddress(c.env, owner.mailboxId))) {
        return apiError(c, 404, "NOT_FOUND", "Team address not found");
      }

      return c.json(signatureView(owner, await loadSignature(c.env, owner)));
    }
  )
  .put(
    "/team-signatures/:mailboxId",
    requirePermission("manage_teams"),
    zValidator("json", signatureSchema),
    async (c) => {
      const owner = { mailboxId: c.req.param("mailboxId") };

      if (!(await isTeamAddress(c.env, owner.mailboxId))) {
        return apiError(c, 404, "NOT_FOUND", "Team address not found");
      }

      return saveResponse(c, owner, c.req.valid("json"));
    }
  )
  .get(
    "/signature-images/:ownerId/:contentId",
    oauthScope(MAIL_READ_SCOPE),
    async (c) => {
      const { ownerId: owner, contentId } = c.req.param();

      // The person's own, a mailbox they can read (a team's), or any team
      // address's for people who edit them.
      const allowed =
        owner === c.get("user").id ||
        Boolean(await accessibleMailbox(c, owner, "read")) ||
        (can(c, "manage_teams") && (await isTeamAddress(c.env, owner)));

      const object = allowed
        ? await c.env.MAIL_STORAGE.get(
            `${signatureImagePrefix(owner)}${contentId}`
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
