import { inArray, sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { teams, users } from "../db/schema";

export async function hasKnownUserIds(db: Database, ids: string[]) {
  if (ids.length === 0) return true;

  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, ids));

  return rows.length === ids.length;
}

export async function hasKnownTeamIds(db: Database, ids: string[]) {
  if (ids.length === 0) return true;

  const rows = await db
    .select({ id: teams.id })
    .from(teams)
    .where(inArray(teams.id, ids));

  return rows.length === ids.length;
}

/**
 * For an UPDATE of `userId` that demotes or disables them: true unless they
 * are the last active administrator. Part of the statement itself, so two
 * such changes racing each other cannot both pass it.
 */
export function anotherActiveAdministratorRemains(userId: string) {
  return sql`(${users.role} <> 'admin' OR ${users.status} <> 'active' OR EXISTS (
    SELECT 1 FROM "users" AS "other"
    WHERE "other"."role" = 'admin' AND "other"."status" = 'active' AND "other"."id" <> ${userId}
  ))`;
}
