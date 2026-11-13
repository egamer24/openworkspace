import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import { hasWorkspacePermission } from "../../shared/workspace";
import type { WorkspacePermission } from "../../shared/workspace";
import type { AppEnv, SessionUser } from "../env";
import { apiError } from "../lib/http";
import { workspacePermissions } from "../modules";

/** Everything the user may manage: all of it for administrators, otherwise what they were given. */
export function effectivePermissions(
  user: Pick<SessionUser, "role" | "permissions">
): WorkspacePermission[] {
  const ids = workspacePermissions().map((permission) => permission.id);

  if (user.role === "admin") return ids;
  const granted = new Set(user.permissions);

  return ids.filter((permission) => granted.has(permission));
}

/**
 * What this request may manage: the signed-in person's permissions, and for
 * an app's OAuth token only those its granted scopes hand it.
 */
export function requestPermissions(c: Context<AppEnv>) {
  const permissions = effectivePermissions(c.get("user"));

  if (c.get("authKind") !== "oauth") return permissions;
  const granted = new Set(c.get("oauthScopes"));

  const scoped = new Set(
    workspacePermissions()
      .filter((item) => granted.has(item.scope))
      .map((item) => item.id)
  );

  return permissions.filter((permission) => scoped.has(permission));
}

/**
 * Whether this request acts with an administrator's powers for something
 * only administrators do: always in a browser session, and for an app's
 * OAuth token only with the scope that covers it.
 */
export function actsAsAdministrator(c: Context<AppEnv>, scope: string) {
  if (c.get("user").role !== "admin") return false;

  return c.get("authKind") !== "oauth" || c.get("oauthScopes").includes(scope);
}

export function can(c: Context<AppEnv>, permission: WorkspacePermission) {
  return hasWorkspacePermission(
    { role: c.get("user").role, permissions: requestPermissions(c) },
    permission
  );
}

/** Lets the request through only if the signed-in user holds `permission`. */
export function requirePermission(permission: WorkspacePermission) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!can(c, permission)) {
      return apiError(
        c,
        403,
        "FORBIDDEN",
        "You do not have permission to manage this"
      );
    }

    await next();
  });
}

/** Admin area entry: administrators, and members given something to manage. */
export const requireAnyPermission = createMiddleware<AppEnv>(
  async (c, next) => {
    if (requestPermissions(c).length === 0) {
      return apiError(c, 403, "FORBIDDEN", "Administrator access is required");
    }

    await next();
  }
);

/** The signed-in user as the app sees it: profile and what they may manage. */
export function sessionUserDetails(user: SessionUser) {
  return { ...user, permissions: effectivePermissions(user) };
}
