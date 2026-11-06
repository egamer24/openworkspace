import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { attachmentPreview } from "../../shared/attachment-preview";
import { DEFAULT_DRIVE_QUOTA_BYTES, type DriveRole } from "../../shared/drive";
import { createDb } from "../db/client";
import { driveItems, driveQuotas, settings, type DriveItem } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";

const DRIVE_ENABLED_KEY = "drive_enabled";
// ponytail: tree walks stop at this depth (access checks fail closed; deeper R2 objects would
// survive a permanent delete). Enforce a nesting limit on create/move if that ever matters.
const MAX_TREE_DEPTH = 64;
export const STALE_UPLOAD_MS = 60 * 60 * 1_000;

export type DriveAccessRole = "owner" | DriveRole;

export async function driveEnabled(binding: D1Database) {
  const [setting] = await createDb(binding)
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, DRIVE_ENABLED_KEY))
    .limit(1);
  return setting?.value === "true";
}

export async function setDriveEnabled(binding: D1Database, enabled: boolean) {
  const now = new Date();
  await createDb(binding)
    .insert(settings)
    .values({ key: DRIVE_ENABLED_KEY, value: String(enabled), updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: String(enabled), updatedAt: now },
    });
  return { enabled };
}

/** Drive is an optional module: while it is off, every Drive URL is a plain 404. */
export const requireDriveEnabled = createMiddleware<AppEnv>(async (c, next) => {
  if (!await driveEnabled(c.env.DB)) {
    return apiError(c, 404, "NOT_FOUND", "Not found");
  }
  await next();
});

export function driveStagingKey(itemId: string) {
  return `drive/staging/${itemId}`;
}

export function driveObjectKey(itemId: string) {
  return `drive/files/${itemId}`;
}

export async function driveQuota(binding: D1Database, userId: string) {
  const [row] = await createDb(binding)
    .select({ quotaBytes: driveQuotas.quotaBytes })
    .from(driveQuotas)
    .where(eq(driveQuotas.userId, userId))
    .limit(1);
  return row?.quotaBytes ?? DEFAULT_DRIVE_QUOTA_BYTES;
}

export async function driveUsage(binding: D1Database, userId: string) {
  const row = await binding
    .prepare("SELECT coalesce(sum(size), 0) AS used FROM drive_items WHERE owner_user_id = ?")
    .bind(userId)
    .first<{ used: number }>();
  return row?.used ?? 0;
}

/**
 * Reserve quota and the name in one statement, so concurrent uploads cannot
 * both pass the check. Pending and trashed files count toward the quota.
 * Returns false when the quota would be exceeded; throws on a name conflict.
 */
export async function insertDriveItemWithinQuota(
  binding: D1Database,
  item: {
    id: string;
    ownerUserId: string;
    parentId: string | null;
    name: string;
    kind: "file" | "folder";
    status: "pending" | "ready";
    size: number;
    contentType: string | null;
    r2Key: string | null;
    createdByUserId: string;
  },
) {
  const quota = await driveQuota(binding, item.ownerUserId);
  const now = Date.now();
  const result = await binding
    .prepare(
      `INSERT INTO drive_items
         (id, owner_user_id, parent_id, name, kind, status, size, content_type, r2_key,
          created_by_user_id, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11
       WHERE (SELECT coalesce(sum(size), 0) FROM drive_items WHERE owner_user_id = ?2) + ?7 <= ?12`,
    )
    .bind(
      item.id,
      item.ownerUserId,
      item.parentId,
      item.name,
      item.kind,
      item.status,
      item.size,
      item.contentType,
      item.r2Key,
      item.createdByUserId,
      now,
      quota,
    )
    .run();
  return result.meta.changes > 0;
}

export function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current.message.includes("UNIQUE constraint failed")) return true;
  }
  return false;
}

type ChainRow = { id: string; name: string; depth: number; role: DriveRole | null };

/**
 * Resolve what `userId` may do with an item. Shares on a folder apply to
 * everything below it; the strongest share on the ancestor chain wins.
 * Returns null when the user has no access, so callers answer 404 and do not
 * reveal that the item exists.
 */
export async function driveItemContext(
  binding: D1Database,
  userId: string,
  itemId: string,
): Promise<{
  item: DriveItem;
  role: DriveAccessRole;
  path: Array<{ id: string; name: string }>;
} | null> {
  const [item] = await createDb(binding)
    .select()
    .from(driveItems)
    .where(eq(driveItems.id, itemId))
    .limit(1);
  if (!item) return null;
  const { results } = await binding
    .prepare(
      `WITH RECURSIVE chain(id, parent_id, name, depth) AS (
         SELECT id, parent_id, name, 0 FROM drive_items WHERE id = ?1
         UNION ALL
         SELECT d.id, d.parent_id, d.name, chain.depth + 1
         FROM drive_items d JOIN chain ON d.id = chain.parent_id
         WHERE chain.depth < ${MAX_TREE_DEPTH}
       )
       SELECT chain.id, chain.name, chain.depth, s.role
       FROM chain LEFT JOIN drive_shares s ON s.item_id = chain.id AND s.user_id = ?2
       ORDER BY chain.depth DESC`,
    )
    .bind(itemId, userId)
    .all<ChainRow>();
  const ancestors = results.filter((row) => row.depth > 0);

  if (item.ownerUserId === userId) {
    return { item, role: "owner", path: ancestors.map(({ id, name }) => ({ id, name })) };
  }
  // Viewers and editors never see trashed or half-uploaded items.
  if (item.trashedAt || item.status !== "ready") return null;
  const firstShared = results.findIndex((row) => row.role !== null);
  if (firstShared < 0) return null;
  const role = results.some((row) => row.role === "editor") ? "editor" : "viewer";
  return {
    item,
    role,
    // Breadcrumbs start at the folder that was shared, never above it.
    path: results
      .slice(firstShared)
      .filter((row) => row.depth > 0)
      .map(({ id, name }) => ({ id, name })),
  };
}

export async function isDescendantOrSelf(
  binding: D1Database,
  candidateId: string,
  ancestorId: string,
) {
  const row = await binding
    .prepare(
      `WITH RECURSIVE chain(id, parent_id, depth) AS (
         SELECT id, parent_id, 0 FROM drive_items WHERE id = ?1
         UNION ALL
         SELECT d.id, d.parent_id, chain.depth + 1
         FROM drive_items d JOIN chain ON d.id = chain.parent_id
         WHERE chain.depth < ${MAX_TREE_DEPTH}
       )
       SELECT 1 AS found FROM chain WHERE id = ?2 LIMIT 1`,
    )
    .bind(candidateId, ancestorId)
    .first<{ found: number }>();
  return Boolean(row);
}

const SUBTREE_CTE = `WITH RECURSIVE subtree(id, depth) AS (
  SELECT id, 0 FROM drive_items WHERE id = ?1
  UNION ALL
  SELECT d.id, subtree.depth + 1 FROM drive_items d JOIN subtree ON d.parent_id = subtree.id
  WHERE subtree.depth < ${MAX_TREE_DEPTH}
)`;

/** Trash a whole subtree with one shared timestamp so restore can undo exactly this action. */
export async function trashDriveSubtree(binding: D1Database, itemId: string) {
  const now = Date.now();
  await binding
    .prepare(
      `${SUBTREE_CTE}
       UPDATE drive_items SET trashed_at = ?2, updated_at = ?2
       WHERE id IN (SELECT id FROM subtree) AND trashed_at IS NULL`,
    )
    .bind(itemId, now)
    .run();
}

export async function restoreDriveSubtree(
  binding: D1Database,
  item: DriveItem,
  parentTrashed: boolean,
) {
  const now = Date.now();
  const trashedAt = item.trashedAt?.getTime() ?? 0;
  await binding.batch([
    // A restored item whose folder is still in the trash lands at the root.
    ...(parentTrashed
      ? [binding.prepare("UPDATE drive_items SET parent_id = NULL WHERE id = ?1").bind(item.id)]
      : []),
    binding
      .prepare(
        `${SUBTREE_CTE}
         UPDATE drive_items SET trashed_at = NULL, updated_at = ?2
         WHERE id IN (SELECT id FROM subtree) AND trashed_at = ?3`,
      )
      .bind(item.id, now, trashedAt),
  ]);
}

/** Delete R2 objects first: if that fails the rows stay in the trash and the delete can be retried. */
export async function deleteDriveSubtree(env: Env, itemId: string) {
  const { results } = await env.DB
    .prepare(
      `${SUBTREE_CTE}
       SELECT d.id, d.r2_key AS r2Key FROM drive_items d JOIN subtree ON d.id = subtree.id`,
    )
    .bind(itemId)
    .all<{ id: string; r2Key: string | null }>();
  const keys = results.flatMap((row) =>
    row.r2Key ? [row.r2Key, driveStagingKey(row.id)] : [driveStagingKey(row.id)]
  );
  for (let offset = 0; offset < keys.length; offset += 1_000) {
    await env.MAIL_STORAGE.delete(keys.slice(offset, offset + 1_000));
  }
  await env.DB.prepare("DELETE FROM drive_items WHERE id = ?1").bind(itemId).run();
}

/** Abandoned uploads would hold quota and names forever; sweep them on the next upload. */
export async function sweepStaleUploads(env: Env, ownerUserId: string) {
  const { results } = await env.DB
    .prepare(
      `SELECT id FROM drive_items
       WHERE owner_user_id = ?1 AND status = 'pending' AND created_at < ?2 LIMIT 100`,
    )
    .bind(ownerUserId, Date.now() - STALE_UPLOAD_MS)
    .all<{ id: string }>();
  if (!results.length) return;
  const ids = results.map((row) => row.id);
  await env.MAIL_STORAGE.delete(ids.map(driveStagingKey));
  await env.DB.batch(
    ids.map((id) => env.DB.prepare("DELETE FROM drive_items WHERE id = ?1").bind(id)),
  );
}

export function serializeDriveItem(item: DriveItem) {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    size: item.size,
    contentType: item.contentType,
    parentId: item.parentId,
    ownerUserId: item.ownerUserId,
    createdByUserId: item.createdByUserId,
    trashedAt: item.trashedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * Serve stored bytes without letting user content run on the app origin.
 * Only types the existing attachment previewer understands (PDF, raster
 * images, plain text) may be inline; everything else, notably HTML, SVG and
 * scripts, is always a download. Every response is sandboxed and nosniff.
 */
export function driveFileResponse(
  object: R2ObjectBody,
  item: Pick<DriveItem, "name" | "contentType">,
  inline: boolean,
) {
  const preview = inline
    ? attachmentPreview({ filename: item.name, contentType: item.contentType ?? "" })
    : null;
  return new Response(object.body, {
    headers: {
      "cache-control": "private, no-store",
      "content-length": String(object.size),
      "content-type": preview?.contentType ?? "application/octet-stream",
      "content-disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
      "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
    },
  });
}
