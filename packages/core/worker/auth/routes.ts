import { Hono } from "hono";
import type { Context } from "hono";

import type { AccessLinkKind } from "../../shared/auth";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import {
  clientAddress,
  overRateLimit,
  rateLimitedResponse,
} from "../lib/rate-limit";
import type { RateLimitBinding } from "../lib/rate-limit";
import { zValidator } from "../lib/validator";
import { OidcError } from "../oidc/errors";
import { browserLoginTransaction } from "../oidc/transaction";
import { SamlError } from "../saml/errors";
import { browserSamlTransaction } from "../saml/transaction";
import { requestScimSync } from "../scim/sync";
import { deferWebhookTask, queueUserWebhookEvent } from "../webhooks/service";
import { deleteAvatar, uploadAvatar } from "./avatar";
import { connectedAppRoutes } from "./connected-app-routes";
import { AuthRequestError } from "./errors";
import { requireSessionAuth } from "./middleware";
import { completeOidcLogin } from "./oidc-login";
import { completeSamlLogin } from "./saml-login";
import {
  authenticationVerificationSchema,
  bootstrapInputSchema,
  loginOptionsSchema,
  registrationVerificationSchema,
} from "./schemas";
import {
  beginAccessLinkRegistration,
  beginBootstrap,
  beginLogin,
  finishAccessLinkRegistration,
  finishBootstrap,
  finishLogin,
  getAccessLinkPreview,
} from "./service";
import { destroySession, establishSession } from "./session";
import { accountSessionRoutes } from "./session-routes";

function authFailure(c: Parameters<typeof apiError>[0], cause: unknown) {
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

/**
 * Per-address throttles for the ceremonies that guess at nothing but cost
 * work: sign-in, first-administrator setup, and invitation and recovery
 * links (looking one up, and redeeming it).
 */
const authLimits = {
  "passkey-login": ["RATE_LIMIT_30", "Too many authentication attempts"],
  bootstrap: ["RATE_LIMIT_10", "Too many setup attempts"],
  "access-link": ["RATE_LIMIT_30", "Too many attempts with this link"],
} as const satisfies Record<string, readonly [RateLimitBinding, string]>;

async function rateLimitAuth(
  c: Context<AppEnv>,
  action: keyof typeof authLimits = "passkey-login"
) {
  const [binding, message] = authLimits[action];

  if (!(await overRateLimit(c, binding, action, clientAddress(c.req.raw)))) {
    return null;
  }

  return rateLimitedResponse(c, message);
}

function accessLinkRoutes(kind: AccessLinkKind) {
  return new Hono<AppEnv>()
    .use(
      "*",
      async (c, next) => (await rateLimitAuth(c, "access-link")) ?? next()
    )
    .get("/:token", async (c) => {
      try {
        const accessLink = await getAccessLinkPreview(
          createDb(c.env.DB),
          c.req.param("token"),
          kind
        );

        return c.json({
          ok: true as const,
          accessLink,
        });
      } catch (error) {
        if (!(error instanceof AuthRequestError)) throw error;

        return apiError(c, 404, "NOT_FOUND", error.message);
      }
    })
    .post("/:token/options", async (c) => {
      try {
        const result = await beginAccessLinkRegistration(
          createDb(c.env.DB),
          c.env,
          c.req.param("token"),
          kind
        );

        return c.json({
          ok: true as const,
          options: result.options,
          challengeId: result.challenge.id,
        });
      } catch (error) {
        return authFailure(c, error);
      }
    })
    .post(
      "/:token/verify",
      zValidator("json", registrationVerificationSchema),
      async (c) => {
        try {
          const db = createDb(c.env.DB);
          const input = c.req.valid("json");

          const userId = await finishAccessLinkRegistration(
            c.env,
            db,
            input.challengeId,
            input.response,
            kind,
            (task) => c.executionCtx.waitUntil(task)
          );

          await establishSession(db, c, userId);

          if (kind === "invitation") {
            // Newly active people may be due in provisioned applications.
            c.executionCtx.waitUntil(
              requestScimSync(c.env).catch((error) =>
                console.error("Could not request SCIM sync", error)
              )
            );
            deferWebhookTask(
              (task) => c.executionCtx.waitUntil(task),
              (eventId) =>
                queueUserWebhookEvent(c.env, "user.joined", userId, eventId)
            );
          }

          return c.json({ ok: true as const });
        } catch (error) {
          return authFailure(c, error);
        }
      }
    );
}

export const authRoutes = new Hono<AppEnv>()
  .use(
    "/bootstrap/*",
    async (c, next) => (await rateLimitAuth(c, "bootstrap")) ?? next()
  )
  .post(
    "/bootstrap/options",
    zValidator("json", bootstrapInputSchema),
    async (c) => {
      try {
        const result = await beginBootstrap(
          createDb(c.env.DB),
          c.env,
          c.req.valid("json")
        );

        return c.json({
          ok: true as const,
          options: result.options,
          challengeId: result.challenge.id,
        });
      } catch (error) {
        return authFailure(c, error);
      }
    }
  )
  .post(
    "/bootstrap/verify",
    zValidator("json", registrationVerificationSchema),
    async (c) => {
      try {
        const db = createDb(c.env.DB);
        const input = c.req.valid("json");

        const userId = await finishBootstrap(
          db,
          input.challengeId,
          input.response
        );

        await establishSession(db, c, userId);

        return c.json({ ok: true as const });
      } catch (error) {
        return authFailure(c, error);
      }
    }
  )
  .post(
    "/login/options",
    zValidator("query", loginOptionsSchema),
    async (c) => {
      const limited = await rateLimitAuth(c);

      if (limited) return limited;

      try {
        const db = createDb(c.env.DB);
        const { oidcRequestId, samlRequestId } = c.req.valid("query");

        if (oidcRequestId) {
          await browserLoginTransaction(db, c, oidcRequestId);
        }

        if (samlRequestId) {
          await browserSamlTransaction(db, c, samlRequestId);
        }

        const result = await beginLogin(db, c.env, {
          oidcRequestId,
          samlRequestId,
        });

        return c.json({
          ok: true as const,
          options: result.options,
          challengeId: result.challenge.id,
        });
      } catch (error) {
        return authFailure(c, error);
      }
    }
  )
  .post(
    "/login/verify",
    zValidator("json", authenticationVerificationSchema),
    async (c) => {
      const limited = await rateLimitAuth(c);

      if (limited) return limited;

      try {
        const db = createDb(c.env.DB);
        const input = c.req.valid("json");
        const result = await finishLogin(db, input.challengeId, input.response);

        if (result.oidcRequestId) {
          const oidcLogin = await completeOidcLogin(
            db,
            c,
            result.userId,
            result.oidcRequestId
          );

          return c.json({
            ok: true as const,
            ...oidcLogin,
          });
        }

        if (result.samlRequestId) {
          const samlLogin = await completeSamlLogin(
            db,
            c,
            result.userId,
            result.samlRequestId
          );

          return c.json({
            ok: true as const,
            ...samlLogin,
          });
        }

        await establishSession(db, c, result.userId);

        return c.json({
          ok: true as const,
          redirectTo: null,
        });
      } catch (error) {
        return authFailure(c, error);
      }
    }
  )
  .route("/invitation", accessLinkRoutes("invitation"))
  .route("/recovery", accessLinkRoutes("recovery"))
  .route("/sessions", accountSessionRoutes)
  .route("/connected-apps", connectedAppRoutes)
  .post("/avatar", requireSessionAuth, (c) => uploadAvatar(c))
  .delete("/avatar", requireSessionAuth, (c) => deleteAvatar(c))
  .post("/logout", requireSessionAuth, async (c) => {
    await destroySession(createDb(c.env.DB), c, {
      sessionId: c.get("sessionId"),
      userId: c.get("user").id,
    });

    return c.json({ ok: true as const });
  });
