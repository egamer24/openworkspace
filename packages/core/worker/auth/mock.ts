import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";

import { mailDomainAllowed, mailDomainRefusal } from "../config/mail-domains";
import { createDb } from "../db/client";
import { users } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { createId } from "../lib/ids";
import { zValidator } from "../lib/validator";
import { runModuleHooks } from "../modules";
import { OidcError } from "../oidc/errors";
import { browserLoginTransaction } from "../oidc/transaction";
import { SamlError } from "../saml/errors";
import { browserSamlTransaction } from "../saml/transaction";
import { AuthRequestError } from "./errors";
import { completeOidcLogin } from "./oidc-login";
import {
  FirstAccountTakenError,
  provisionBootstrapAccount,
} from "./personal-account";
import { completeSamlLogin } from "./saml-login";
import { mockBootstrapSchema, mockLoginSchema } from "./schemas";
import { hasUsers } from "./service";
import { establishSession } from "./session";

/**
 * Mock sign-in and the seeded demo exist for local development only: the
 * ALLOW_MOCK_AUTH flag must be set and the request must be for localhost or
 * 127.0.0.1, so a deployment with the flag left on still refuses it.
 */
export function mockAuthAllowed(c: {
  env: AppEnv["Bindings"];
  req: { url: string };
}) {
  return (
    c.env.ALLOW_MOCK_AUTH === "true" &&
    ["localhost", "127.0.0.1"].includes(new URL(c.req.url).hostname)
  );
}

function mockAuthFailure(c: Context<AppEnv>, cause: unknown) {
  if (cause instanceof AuthRequestError) {
    return apiError(c, cause.status, cause.code, cause.message);
  }

  if (cause instanceof OidcError && cause.status < 500) {
    return apiError(c, 400, "WEBAUTHN_FAILED", cause.message);
  }

  if (cause instanceof SamlError && cause.status < 500) {
    return apiError(c, 400, "WEBAUTHN_FAILED", cause.message);
  }

  throw cause;
}

export const mockAuthRoutes = new Hono<AppEnv>()
  .post("/bootstrap", zValidator("json", mockBootstrapSchema), async (c) => {
    if (!mockAuthAllowed(c)) {
      return apiError(c, 404, "NOT_FOUND", "Not found");
    }

    const db = createDb(c.env.DB);
    const input = c.req.valid("json");
    const userId = createId("usr");
    const mailboxId = createId("mbx");
    const now = new Date();

    if (await hasUsers(db)) {
      return apiError(c, 409, "CONFLICT", "Account is already set up");
    }

    if (!mailDomainAllowed(input.email)) {
      return apiError(c, 400, "BAD_REQUEST", mailDomainRefusal());
    }

    try {
      await provisionBootstrapAccount(db, {
        userId,
        mailboxId,
        name: input.name,
        email: input.email,
        role: "admin",
        status: "active",
        createdByUserId: userId,
        now,
      });
    } catch (error) {
      if (error instanceof FirstAccountTakenError) {
        return apiError(c, 409, "CONFLICT", error.message);
      }

      throw error;
    }

    try {
      await establishSession(db, c, userId);

      return c.json({ ok: true as const });
    } catch (error) {
      return mockAuthFailure(c, error);
    }
  })
  .post("/login", zValidator("json", mockLoginSchema), async (c) => {
    if (!mockAuthAllowed(c)) {
      return apiError(c, 404, "NOT_FOUND", "Not found");
    }

    const db = createDb(c.env.DB);
    const input = c.req.valid("json");

    try {
      if (input.oidcRequestId) {
        await browserLoginTransaction(db, c, input.oidcRequestId);
      }

      if (input.samlRequestId) {
        await browserSamlTransaction(db, c, input.samlRequestId);
      }

      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, input.userId), eq(users.status, "active")))
        .limit(1);

      if (!user) return apiError(c, 404, "NOT_FOUND", "User not found");

      if (user.id === "usr_demo_admin") {
        await runModuleHooks("seedDemo", c.env, { db, userId: user.id });
      }

      if (input.oidcRequestId) {
        const oidcLogin = await completeOidcLogin(
          db,
          c,
          user.id,
          input.oidcRequestId
        );

        return c.json({
          ok: true as const,
          ...oidcLogin,
        });
      }

      if (input.samlRequestId) {
        const samlLogin = await completeSamlLogin(
          db,
          c,
          user.id,
          input.samlRequestId
        );

        return c.json({
          ok: true as const,
          ...samlLogin,
        });
      }

      await establishSession(db, c, user.id);

      return c.json({
        ok: true as const,
        redirectTo: null,
      });
    } catch (error) {
      return mockAuthFailure(c, error);
    }
  });
