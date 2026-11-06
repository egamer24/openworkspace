import { zValidator } from "@hono/zod-validator";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import { createDb } from "../db/client";
import { mailboxAddressPredicate, mailboxAddressSql } from "../db/mailboxes";
import {
  domains,
  driveItems,
  driveLinks,
  driveShares,
  mailboxes,
  users,
  type DriveItem,
} from "../db/schema";
import type { AppEnv } from "../env";
import { hashPassword, hashToken, randomToken } from "../lib/crypto";
import { apiError } from "../lib/http";
import { createId } from "../lib/ids";
import { checkRateLimit } from "../lib/rate-limit";
import { getMailboxAccess } from "../mail/access";
import { signR2PutUrl } from "../mail/r2-presigned-urls";
import { uploadBodyWithExactSize, UploadValidationError } from "../mail/uploads";
import { mailboxStub } from "../mailbox";
import {
  createDriveFolderSchema,
  createDriveLinkSchema,
  createDriveUploadSchema,
  driveListQuerySchema,
  driveShareSchema,
  saveAttachmentToDriveSchema,
  updateDriveItemSchema,
} from "./schemas";
import {
  deleteDriveSubtree,
  driveFileResponse,
  driveItemContext,
  driveObjectKey,
  driveQuota,
  driveStagingKey,
  driveUsage,
  insertDriveItemWithinQuota,
  isDescendantOrSelf,
  isUniqueViolation,
  requireDriveEnabled,
  restoreDriveSubtree,
  serializeDriveItem,
  sweepStaleUploads,
  trashDriveSubtree,
  type DriveAccessRole,
} from "./service";

type Bindings = AppEnv["Bindings"];

const MAX_LIST_ITEMS = 500;
const NOT_FOUND = "Item not found";
const NAME_TAKEN = "An item with this name already exists here";

function canEdit(role: DriveAccessRole) {
  return role === "owner" || role === "editor";
}

function isLive(item: DriveItem) {
  return item.status === "ready" && !item.trashedAt;
}

/** Where a new item lands and whose quota it uses: the target folder's owner. */
async function writableParent(env: Bindings, userId: string, parentId: string | null) {
  if (!parentId) return { ownerUserId: userId, parentId: null };
  const context = await driveItemContext(env.DB, userId, parentId);
  if (
    !context
    || context.item.kind !== "folder"
    || !isLive(context.item)
    || !canEdit(context.role)
  ) {
    return null;
  }
  return { ownerUserId: context.item.ownerUserId, parentId };
}

async function loadItem(db: ReturnType<typeof createDb>, itemId: string) {
  const [item] = await db.select().from(driveItems).where(eq(driveItems.id, itemId)).limit(1);
  return item ?? null;
}

function serializeLink(link: typeof driveLinks.$inferSelect) {
  return {
    id: link.id,
    itemId: link.itemId,
    access: link.access,
    hasPassword: link.passwordHash !== null,
    expiresAt: link.expiresAt,
    accessCount: link.accessCount,
    lastAccessedAt: link.lastAccessedAt,
    createdAt: link.createdAt,
  };
}

function attachmentDriveName(filename: string) {
  return filename.replace(/[/\\\u0000-\u001f]/gu, "_").trim().slice(0, 255) || "attachment";
}

// Trash shows only the item the user trashed, not every descendant it took along.
const trashRootSql = sql`NOT EXISTS (
  SELECT 1 FROM drive_items AS parent
  WHERE parent.id = ${driveItems.parentId} AND parent.trashed_at = ${driveItems.trashedAt}
)`;

export const driveRoutes = new Hono<AppEnv>()
  .use("*", requireDriveEnabled, requireAuth)
  .get("/status", async (c) => {
    const userId = c.get("user").id;
    const [usedBytes, quotaBytes] = await Promise.all([
      driveUsage(c.env.DB, userId),
      driveQuota(c.env.DB, userId),
    ]);
    return c.json({ ok: true as const, enabled: true as const, usedBytes, quotaBytes });
  })
  .get("/items", zValidator("query", driveListQuerySchema), async (c) => {
    const user = c.get("user");
    const query = c.req.valid("query");
    const db = createDb(c.env.DB);
    const conditions: SQL[] = [eq(driveItems.status, "ready")];
    let folder: ReturnType<typeof serializeDriveItem> | null = null;
    let path: Array<{ id: string; name: string }> = [];
    let role: DriveAccessRole = "owner";

    if (query.view === "trash") {
      conditions.push(
        eq(driveItems.ownerUserId, user.id),
        isNotNull(driveItems.trashedAt),
        trashRootSql,
      );
    } else if (query.view === "shared") {
      conditions.push(
        isNull(driveItems.trashedAt),
        exists(
          db.select({ one: sql`1` }).from(driveShares).where(and(
            eq(driveShares.itemId, driveItems.id),
            eq(driveShares.userId, user.id),
          )),
        ),
      );
    } else if (query.search) {
      // ponytail: searches the user's own drive only; shared-tree search needs a per-row access check.
      const pattern = `%${query.search.toLowerCase().replace(/[\\%_]/gu, "\\$&")}%`;
      conditions.push(
        eq(driveItems.ownerUserId, user.id),
        isNull(driveItems.trashedAt),
        sql`lower(${driveItems.name}) LIKE ${pattern} ESCAPE '\\'`,
      );
    } else if (query.parentId) {
      const context = await driveItemContext(c.env.DB, user.id, query.parentId);
      if (!context || context.item.kind !== "folder" || !isLive(context.item)) {
        return apiError(c, 404, "NOT_FOUND", NOT_FOUND);
      }
      folder = serializeDriveItem(context.item);
      path = context.path;
      role = context.role;
      conditions.push(eq(driveItems.parentId, query.parentId), isNull(driveItems.trashedAt));
    } else {
      conditions.push(
        eq(driveItems.ownerUserId, user.id),
        isNull(driveItems.parentId),
        isNull(driveItems.trashedAt),
      );
    }

    const direction = query.order === "desc" ? desc : asc;
    const sortColumn = query.sort === "size"
      ? driveItems.size
      : query.sort === "date"
        ? driveItems.updatedAt
        : sql`lower(${driveItems.name})`;
    // ponytail: capped list without pagination; add a cursor when folders outgrow it.
    const rows = await db
      .select({ item: driveItems, ownerName: users.name, shareRole: driveShares.role })
      .from(driveItems)
      .innerJoin(users, eq(users.id, driveItems.ownerUserId))
      .leftJoin(driveShares, and(
        eq(driveShares.itemId, driveItems.id),
        eq(driveShares.userId, user.id),
      ))
      .where(and(...conditions))
      .orderBy(sql`${driveItems.kind} = 'file'`, direction(sortColumn), asc(driveItems.id))
      .limit(MAX_LIST_ITEMS);
    return c.json({
      ok: true as const,
      folder,
      path,
      role,
      items: rows.map((row) => ({
        ...serializeDriveItem(row.item),
        ownerName: row.ownerName,
        role: (query.view === "shared" ? row.shareRole ?? "viewer" : role) as DriveAccessRole,
      })),
    });
  })
  .get("/items/:id", async (c) => {
    const context = await driveItemContext(c.env.DB, c.get("user").id, c.req.param("id"));
    if (!context || context.item.status !== "ready") {
      return apiError(c, 404, "NOT_FOUND", NOT_FOUND);
    }
    return c.json({
      ok: true as const,
      item: serializeDriveItem(context.item),
      role: context.role,
      path: context.path,
    });
  })
  .post("/folders", zValidator("json", createDriveFolderSchema), async (c) => {
    const user = c.get("user");
    const input = c.req.valid("json");
    const parent = await writableParent(c.env, user.id, input.parentId);
    if (!parent) return apiError(c, 404, "NOT_FOUND", "Folder not found");
    const id = createId("drv");
    const now = new Date();
    try {
      // Folders are free: an over-quota user can still organize what they have.
      await createDb(c.env.DB).insert(driveItems).values({
        id,
        ownerUserId: parent.ownerUserId,
        parentId: parent.parentId,
        name: input.name,
        kind: "folder",
        status: "ready",
        createdByUserId: user.id,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (isUniqueViolation(error)) return apiError(c, 409, "CONFLICT", NAME_TAKEN);
      throw error;
    }
    const item = await loadItem(createDb(c.env.DB), id);
    return c.json({ ok: true as const, item: serializeDriveItem(item!) }, 201);
  })
  .post("/uploads", zValidator("json", createDriveUploadSchema), async (c) => {
    const user = c.get("user");
    const input = c.req.valid("json");
    const rate = await checkRateLimit(c.env.DB, {
      action: "drive-upload",
      identifier: user.id,
      limit: 60,
      windowMs: 60_000,
    });
    if (!rate.allowed) {
      c.header("retry-after", String(rate.retryAfterSeconds));
      return apiError(c, 429, "RATE_LIMITED", "Too many uploads");
    }
    const parent = await writableParent(c.env, user.id, input.parentId);
    if (!parent) return apiError(c, 404, "NOT_FOUND", "Folder not found");
    await sweepStaleUploads(c.env, parent.ownerUserId);

    const id = createId("drv");
    const contentType = input.contentType.split(";", 1)[0]!.trim().toLowerCase()
      || "application/octet-stream";
    try {
      const reserved = await insertDriveItemWithinQuota(c.env.DB, {
        id,
        ownerUserId: parent.ownerUserId,
        parentId: parent.parentId,
        name: input.name,
        kind: "file",
        status: "pending",
        size: input.size,
        contentType,
        r2Key: null,
        createdByUserId: user.id,
      });
      if (!reserved) {
        return apiError(c, 413, "QUOTA_EXCEEDED", "This upload would exceed the Drive storage quota");
      }
    } catch (error) {
      if (isUniqueViolation(error)) return apiError(c, 409, "CONFLICT", NAME_TAKEN);
      throw error;
    }

    const presigned = await signR2PutUrl({
      env: c.env,
      r2Key: driveStagingKey(id),
      contentType,
    });
    // Without R2 S3 credentials the browser PUTs through the Worker instead.
    const uploadUrl = presigned
      ?? new URL(`/api/drive/uploads/${id}/content`, c.req.url).toString();
    const item = await loadItem(createDb(c.env.DB), id);
    return c.json({
      ok: true as const,
      item: serializeDriveItem(item!),
      upload: { uploadUrl, headers: { "content-type": contentType } },
    }, 201);
  })
  .put("/uploads/:id/content", async (c) => {
    const user = c.get("user");
    const item = await loadItem(createDb(c.env.DB), c.req.param("id"));
    if (!item || item.status !== "pending" || item.createdByUserId !== user.id) {
      return apiError(c, 404, "NOT_FOUND", "Upload not found");
    }
    const body = c.req.raw.body;
    const contentLength = c.req.header("content-length");
    if (!body || (contentLength !== undefined && Number(contentLength) !== item.size)) {
      return apiError(c, 422, "BAD_REQUEST", "Upload size does not match");
    }
    const stagingKey = driveStagingKey(item.id);
    const sizeState = { mismatch: false };
    try {
      const upload = uploadBodyWithExactSize(body, item.size, sizeState);
      const results = await Promise.allSettled([
        c.env.MAIL_STORAGE.put(stagingKey, upload.body),
        ...(upload.completion ? [upload.completion] : []),
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure && !sizeState.mismatch) throw failure.reason;
    } catch (error) {
      if (!(error instanceof UploadValidationError)) throw error;
      sizeState.mismatch = true;
    }
    if (sizeState.mismatch) {
      await c.env.MAIL_STORAGE.delete(stagingKey);
      return apiError(c, 422, "BAD_REQUEST", "Upload size does not match");
    }
    return c.json({ ok: true as const });
  })
  .post("/uploads/:id/complete", async (c) => {
    const user = c.get("user");
    const db = createDb(c.env.DB);
    const item = await loadItem(db, c.req.param("id"));
    if (!item || item.createdByUserId !== user.id) {
      return apiError(c, 404, "NOT_FOUND", "Upload not found");
    }
    if (item.status === "ready") {
      return c.json({ ok: true as const, item: serializeDriveItem(item) });
    }
    const stagingKey = driveStagingKey(item.id);
    const staging = await c.env.MAIL_STORAGE.get(stagingKey);
    if (!staging || staging.size !== item.size) {
      if (staging) await c.env.MAIL_STORAGE.delete(stagingKey);
      return apiError(c, 422, "BAD_REQUEST", "Upload is incomplete");
    }
    // Copy out of the presigned staging key so a replayed upload URL cannot
    // swap the bytes (or their size) after the quota check.
    const r2Key = driveObjectKey(item.id);
    await c.env.MAIL_STORAGE.put(r2Key, staging.body, {
      httpMetadata: { contentType: item.contentType ?? "application/octet-stream" },
    });
    await c.env.MAIL_STORAGE.delete(stagingKey);
    const [ready] = await db
      .update(driveItems)
      .set({ status: "ready", r2Key, updatedAt: new Date() })
      .where(and(eq(driveItems.id, item.id), eq(driveItems.status, "pending")))
      .returning();
    return c.json({ ok: true as const, item: serializeDriveItem(ready ?? item) });
  })
  .patch("/items/:id", zValidator("json", updateDriveItemSchema), async (c) => {
    const user = c.get("user");
    const input = c.req.valid("json");
    const context = await driveItemContext(c.env.DB, user.id, c.req.param("id"));
    if (!context || !isLive(context.item)) return apiError(c, 404, "NOT_FOUND", NOT_FOUND);
    if (!canEdit(context.role)) return apiError(c, 403, "FORBIDDEN", "Editor access is required");
    const { item } = context;
    const changes: Partial<DriveItem> = { updatedAt: new Date() };
    if (input.name !== undefined) changes.name = input.name;
    if (input.parentId !== undefined && input.parentId !== item.parentId) {
      const target = await writableParent(c.env, user.id, input.parentId);
      if (!target) return apiError(c, 404, "NOT_FOUND", "Folder not found");
      if (target.ownerUserId !== item.ownerUserId) {
        return apiError(c, 422, "BAD_REQUEST", "Items can only move within their owner's drive");
      }
      if (input.parentId && await isDescendantOrSelf(c.env.DB, input.parentId, item.id)) {
        return apiError(c, 422, "BAD_REQUEST", "A folder cannot move into itself");
      }
      changes.parentId = input.parentId;
    }
    try {
      const [updated] = await createDb(c.env.DB)
        .update(driveItems)
        .set(changes)
        .where(eq(driveItems.id, item.id))
        .returning();
      return c.json({ ok: true as const, item: serializeDriveItem(updated!) });
    } catch (error) {
      if (isUniqueViolation(error)) return apiError(c, 409, "CONFLICT", NAME_TAKEN);
      throw error;
    }
  })
  .post("/items/:id/trash", async (c) => {
    const context = await driveItemContext(c.env.DB, c.get("user").id, c.req.param("id"));
    if (!context || !isLive(context.item)) return apiError(c, 404, "NOT_FOUND", NOT_FOUND);
    if (!canEdit(context.role)) return apiError(c, 403, "FORBIDDEN", "Editor access is required");
    await trashDriveSubtree(c.env.DB, context.item.id);
    return c.json({ ok: true as const });
  })
  .post("/items/:id/restore", async (c) => {
    const db = createDb(c.env.DB);
    const item = await loadItem(db, c.req.param("id"));
    if (!item || item.ownerUserId !== c.get("user").id || !item.trashedAt) {
      return apiError(c, 404, "NOT_FOUND", NOT_FOUND);
    }
    const parent = item.parentId ? await loadItem(db, item.parentId) : null;
    try {
      await restoreDriveSubtree(c.env.DB, item, Boolean(parent?.trashedAt));
    } catch (error) {
      if (isUniqueViolation(error)) return apiError(c, 409, "CONFLICT", NAME_TAKEN);
      throw error;
    }
    return c.json({ ok: true as const, item: serializeDriveItem((await loadItem(db, item.id))!) });
  })
  .delete("/items/:id", async (c) => {
    const user = c.get("user");
    const item = await loadItem(createDb(c.env.DB), c.req.param("id"));
    const cancelUpload = item?.status === "pending" && item.createdByUserId === user.id;
    if (!item || (!cancelUpload && item.ownerUserId !== user.id)) {
      return apiError(c, 404, "NOT_FOUND", NOT_FOUND);
    }
    if (!cancelUpload && !item.trashedAt) {
      return apiError(c, 409, "CONFLICT", "Move the item to the trash before deleting it");
    }
    await deleteDriveSubtree(c.env, item.id);
    return c.json({ ok: true as const });
  })
  .get("/items/:id/content", async (c) => {
    const context = await driveItemContext(c.env.DB, c.get("user").id, c.req.param("id"));
    if (!context || !isLive(context.item) || context.item.kind !== "file" || !context.item.r2Key) {
      return apiError(c, 404, "NOT_FOUND", NOT_FOUND);
    }
    const object = await c.env.MAIL_STORAGE.get(context.item.r2Key);
    if (!object) return apiError(c, 404, "NOT_FOUND", "File data is missing");
    return driveFileResponse(object, context.item, c.req.query("inline") === "true");
  })
  .get("/items/:id/shares", async (c) => {
    const db = createDb(c.env.DB);
    const item = await loadItem(db, c.req.param("id"));
    if (!item || item.ownerUserId !== c.get("user").id || !isLive(item)) {
      return apiError(c, 404, "NOT_FOUND", NOT_FOUND);
    }
    const [shares, links] = await Promise.all([
      db
        .select({
          userId: driveShares.userId,
          role: driveShares.role,
          name: users.name,
          email: mailboxAddressSql,
        })
        .from(driveShares)
        .innerJoin(users, eq(users.id, driveShares.userId))
        .leftJoin(mailboxes, and(eq(mailboxes.ownerUserId, users.id), eq(mailboxes.isPrimary, true)))
        .leftJoin(domains, eq(domains.id, mailboxes.domainId))
        .where(eq(driveShares.itemId, item.id))
        .orderBy(users.name),
      db.select().from(driveLinks).where(eq(driveLinks.itemId, item.id)).orderBy(desc(driveLinks.createdAt)),
    ]);
    return c.json({ ok: true as const, shares, links: links.map(serializeLink) });
  })
  .put("/items/:id/shares", zValidator("json", driveShareSchema), async (c) => {
    const user = c.get("user");
    const input = c.req.valid("json");
    const db = createDb(c.env.DB);
    const item = await loadItem(db, c.req.param("id"));
    if (!item || item.ownerUserId !== user.id || !isLive(item)) {
      return apiError(c, 404, "NOT_FOUND", NOT_FOUND);
    }
    const [target] = await db
      .select({ id: users.id })
      .from(mailboxes)
      .innerJoin(domains, mailboxAddressPredicate(input.email))
      .innerJoin(users, eq(users.id, mailboxes.ownerUserId))
      .where(and(eq(mailboxes.isPrimary, true), eq(users.status, "active")))
      .limit(1);
    if (!target) return apiError(c, 404, "NOT_FOUND", "No active user has that address");
    if (target.id === user.id) return apiError(c, 422, "BAD_REQUEST", "You already own this item");
    await db
      .insert(driveShares)
      .values({ itemId: item.id, userId: target.id, role: input.role, createdAt: new Date() })
      .onConflictDoUpdate({
        target: [driveShares.itemId, driveShares.userId],
        set: { role: input.role },
      });
    return c.json({ ok: true as const, userId: target.id, role: input.role });
  })
  .delete("/items/:id/shares/:userId", async (c) => {
    const db = createDb(c.env.DB);
    const item = await loadItem(db, c.req.param("id"));
    if (!item || item.ownerUserId !== c.get("user").id) {
      return apiError(c, 404, "NOT_FOUND", NOT_FOUND);
    }
    await db.delete(driveShares).where(and(
      eq(driveShares.itemId, item.id),
      eq(driveShares.userId, c.req.param("userId")),
    ));
    return c.json({ ok: true as const });
  })
  .post("/items/:id/links", zValidator("json", createDriveLinkSchema), async (c) => {
    const user = c.get("user");
    const input = c.req.valid("json");
    const db = createDb(c.env.DB);
    const item = await loadItem(db, c.req.param("id"));
    if (!item || item.ownerUserId !== user.id || !isLive(item)) {
      return apiError(c, 404, "NOT_FOUND", NOT_FOUND);
    }
    // ponytail: file links only; folder links need a public folder browser.
    if (item.kind !== "file") {
      return apiError(c, 422, "BAD_REQUEST", "Public links are available for files only");
    }
    if (input.expiresAt !== null && input.expiresAt <= Date.now()) {
      return apiError(c, 422, "BAD_REQUEST", "Expiry must be in the future");
    }
    const token = randomToken();
    const [link] = await db.insert(driveLinks).values({
      id: createId("dlk"),
      itemId: item.id,
      tokenHash: await hashToken(token),
      access: input.access,
      passwordHash: input.password ? await hashPassword(input.password) : null,
      expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
      createdByUserId: user.id,
      createdAt: new Date(),
    }).returning();
    return c.json({
      ok: true as const,
      link: serializeLink(link!),
      // The raw token is shown once; only its hash is stored.
      url: new URL(`/d/${token}`, c.req.url).toString(),
    }, 201);
  })
  .delete("/links/:id", async (c) => {
    const db = createDb(c.env.DB);
    const [link] = await db
      .select({ id: driveLinks.id })
      .from(driveLinks)
      .innerJoin(driveItems, eq(driveItems.id, driveLinks.itemId))
      .where(and(eq(driveLinks.id, c.req.param("id")), eq(driveItems.ownerUserId, c.get("user").id)))
      .limit(1);
    if (!link) return apiError(c, 404, "NOT_FOUND", "Link not found");
    await db.delete(driveLinks).where(eq(driveLinks.id, link.id));
    return c.json({ ok: true as const });
  })
  .post("/items/from-attachment", zValidator("json", saveAttachmentToDriveSchema), async (c) => {
    const user = c.get("user");
    const input = c.req.valid("json");
    if (!await getMailboxAccess(createDb(c.env.DB), user.id, input.mailboxId)) {
      return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
    }
    const file = await mailboxStub(c.env, input.mailboxId).getAttachment(
      input.messageId,
      input.attachmentId,
    );
    if (!file) return apiError(c, 404, "NOT_FOUND", "Attachment not found");
    const parent = await writableParent(c.env, user.id, input.parentId);
    if (!parent) return apiError(c, 404, "NOT_FOUND", "Folder not found");

    const id = createId("drv");
    try {
      const reserved = await insertDriveItemWithinQuota(c.env.DB, {
        id,
        ownerUserId: parent.ownerUserId,
        parentId: parent.parentId,
        name: attachmentDriveName(file.filename),
        kind: "file",
        status: "pending",
        size: file.size,
        contentType: file.contentType.split(";", 1)[0]!.trim().toLowerCase() || null,
        r2Key: null,
        createdByUserId: user.id,
      });
      if (!reserved) {
        return apiError(c, 413, "QUOTA_EXCEEDED", "This file would exceed the Drive storage quota");
      }
    } catch (error) {
      if (isUniqueViolation(error)) return apiError(c, 409, "CONFLICT", NAME_TAKEN);
      throw error;
    }
    const db = createDb(c.env.DB);
    const source = await c.env.MAIL_STORAGE.get(file.r2Key);
    if (!source) {
      await db.delete(driveItems).where(eq(driveItems.id, id));
      return apiError(c, 404, "NOT_FOUND", "Attachment data is missing");
    }
    const r2Key = driveObjectKey(id);
    await c.env.MAIL_STORAGE.put(r2Key, source.body, {
      httpMetadata: { contentType: file.contentType },
    });
    const [item] = await db
      .update(driveItems)
      .set({ status: "ready", r2Key, updatedAt: new Date() })
      .where(eq(driveItems.id, id))
      .returning();
    return c.json({ ok: true as const, item: serializeDriveItem(item!) }, 201);
  });
