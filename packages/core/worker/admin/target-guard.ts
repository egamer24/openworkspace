import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import { userTargetRefusalReason } from "../../shared/workspace";
import { effectivePermissions } from "../auth/permissions";
import { createDb } from "../db/client";
import type { Database } from "../db/client";
import { users } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";

export type UserTargetRefusal = {
  status: 403 | 404;
  code: "FORBIDDEN" | "NOT_FOUND";
  message: string;
};

/**
 * Whether the signed-in person may act on another person's account
 * (`userTargetRefusalReason`, shared with the admin UI). An unknown person
 * is never allowed.
 */
export async function userTargetRefusal(
  c: Context<AppEnv>,
  db: Database,
  targetUserId: string
): Promise<UserTargetRefusal | null> {
  const [target] = await db
    .select({ role: users.role, permissions: users.permissions })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);

  if (!target) {
    return { status: 404, code: "NOT_FOUND", message: "User not found" };
  }

  const actor = c.get("user");

  const reason = userTargetRefusalReason(
    { role: actor.role, permissions: effectivePermissions(actor) },
    { role: target.role, permissions: effectivePermissions(target) }
  );

  if (reason === "administrator") {
    return {
      status: 403,
      code: "FORBIDDEN",
      message: "Only administrators can manage an administrator",
    };
  }

  if (reason === "permissions") {
    return {
      status: 403,
      code: "FORBIDDEN",
      message: "You can only manage people whose permissions you also hold",
    };
  }

  return null;
}

/**
 * Route middleware for `/users/:id/*` and the like: checks the person the
 * route names, read from Hono's decoded route parameter, so the target is
 * exactly the one the handler acts on.
 */
export const guardUserTarget = (param: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const refusal = await userTargetRefusal(
      c,
      createDb(c.env.DB),
      c.req.param(param) ?? ""
    );

    if (refusal) {
      return apiError(c, refusal.status, refusal.code, refusal.message);
    }

    await next();
  });
