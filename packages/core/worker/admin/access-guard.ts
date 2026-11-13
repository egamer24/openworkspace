import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { WorkspacePermission } from "../../shared/workspace";
import { effectivePermissions, requestPermissions } from "../auth/permissions";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { moduleAdminSections } from "../modules";

/**
 * What each part of core's admin API requires, by its first path segment.
 * Sections a module serves are the module's to authorize; anything else not
 * listed stays with administrators.
 */
const sectionPermissions = new Map<string, readonly WorkspacePermission[]>([
  ["users", ["manage_people"]],
  ["invitations", ["manage_people"]],
  ["teams", ["manage_teams"]],
  // Personal mailboxes belong to people, team addresses to teams; the
  // mailbox routes check which one a request touches.
  ["mailboxes", ["manage_people", "manage_teams"]],
  ["webhooks", ["manage_webhooks"]],
  ["oidc-clients", ["manage_apps"]],
  ["saml-applications", ["manage_apps"]],
]);

function forbidden(c: Context<AppEnv>) {
  return apiError(
    c,
    403,
    "FORBIDDEN",
    "You do not have permission to manage this"
  );
}

/**
 * Authorizes every admin API request by its section against the caller's
 * role and permissions. The section is read from Hono's decoded path, the
 * one routing used. Which person a request acts on is checked by the routes
 * that name one (target-guard.ts), from their decoded route parameters.
 */
/** Why the request may not reach this admin section, or null when it may. */
function adminAccessRefusal(c: Context<AppEnv>) {
  const user = c.get("user");

  if (effectivePermissions(user).length === 0) {
    return apiError(c, 403, "FORBIDDEN", "Administrator access is required");
  }

  // An app's token reaches only the sections its scopes name (the routes
  // declare them), and administrators may open every section.
  if (user.role === "admin") return null;
  // What this request may manage; for an app's token, only what its scopes hand it.
  const permissions = requestPermissions(c);

  // MCP tools call these routes in-process, without the /api prefix.
  const path = c.req.path.replace(/^(?:\/api)?\/admin/u, "");
  const [, section = ""] = path.split("/");

  // The admin overview is filtered to what the caller may see.
  if (path === "/state") return null;
  const required = sectionPermissions.get(section);

  if (!required && moduleAdminSections().has(section)) return null;
  const anyOf = required ?? [];

  if (
    !anyOf.length ||
    !anyOf.some((permission) => permissions.includes(permission))
  ) {
    return forbidden(c);
  }

  return null;
}

export const adminAccessGuard = createMiddleware<AppEnv>(async (c, next) => {
  const refusal = adminAccessRefusal(c);

  if (refusal) return refusal;
  await next();
});
