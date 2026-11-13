import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import type { H } from "hono/types";

import type { AppEnv } from "../env";
import { apiError } from "../lib/http";

type ScopeRequirement =
  | { allOf: readonly string[] }
  | { anyOf: readonly string[] };

const requirements = new WeakMap<H, ScopeRequirement>();

/** Hono wraps a sub-app's handler and keeps the original here (hono-base.js). */
type ComposedHandler = H & { __COMPOSED_HANDLER?: H };

function marker(requirement: ScopeRequirement) {
  // Only marks the route; `oauthScopeRefusal` (run by `requireAuth`) reads it.
  const middleware: MiddlewareHandler<AppEnv> = async (_c, next) => {
    await next();
  };

  requirements.set(middleware, requirement);

  return middleware;
}

/**
 * Declares the OAuth scopes an app's access token needs for a route, every
 * one of them; browser sessions are unaffected. Put it on the route itself,
 * or on a `use` for a group of routes. A route an OAuth token can reach must
 * declare its scopes: one that declares none refuses OAuth tokens.
 */
export function oauthScope(...scopes: string[]) {
  return marker({ allOf: scopes });
}

/** Like `oauthScope`, but one of these scopes is enough; the route then checks which applies. */
export function oauthScopeAnyOf(...scopes: string[]) {
  return marker({ anyOf: scopes });
}

/** A route's requirement, through the wrapper Hono adds when a sub-app has its own error handler. */
function requirementOf(handler: H): ScopeRequirement | undefined {
  let current: H | undefined = handler;

  while (current) {
    const requirement = requirements.get(current);

    if (requirement) return requirement;
    // SAFETY: Hono's types don't declare the property it sets on a sub-app's
    // wrapper; any other handler lacks it and reads undefined, ending the walk.
    const composed: ComposedHandler = current as ComposedHandler;
    current = composed.__COMPOSED_HANDLER;
  }

  return undefined;
}

/**
 * Whether the request's OAuth scopes reach the route it matched: every
 * requirement declared along the way must be met, and there must be one.
 * The refusal to send, or null.
 */
export function oauthScopeRefusal(c: Context<AppEnv>) {
  const granted = new Set(c.get("oauthScopes"));

  const found = matchedRoutes(c).flatMap((route) => {
    const requirement = requirementOf(route.handler);

    return requirement ? [requirement] : [];
  });

  if (!found.length) {
    return apiError(
      c,
      403,
      "FORBIDDEN",
      "This is not available to apps signed in with OAuth"
    );
  }

  const missing = found.flatMap((requirement) =>
    "allOf" in requirement
      ? requirement.allOf.filter((scope) => !granted.has(scope))
      : requirement.anyOf.some((scope) => granted.has(scope))
        ? []
        : [requirement.anyOf.join(" ")]
  );

  if (!missing.length) return null;
  c.header(
    "www-authenticate",
    `Bearer error="insufficient_scope", scope="${[...new Set(missing)].join(" ")}"`
  );

  return apiError(
    c,
    403,
    "FORBIDDEN",
    `This app was not given access to this (it needs ${[...new Set(missing)].join(", ")})`
  );
}
