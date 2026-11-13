import { Hono } from "hono";
import type { Context } from "hono";

import { SAML_LOGIN_PAGE } from "../../shared/paths";
import { readSessionFromContext } from "../auth/session";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { clientAddress, overRateLimit } from "../lib/rate-limit";
import { samlConfiguration } from "./configuration";
import type { SamlConfiguration } from "./configuration";
import { SamlError, SamlStatusError, samlError } from "./errors";
import { samlMetadata } from "./metadata";
import type { ParsedSamlAuthnRequest } from "./request";
import {
  browserSamlTransaction,
  createSamlTransaction,
  setSamlTransactionCookie,
} from "./transaction";

const protocol = () => import("./protocol");

function publicSamlError(c: Context<AppEnv>, cause: unknown) {
  const normalized = samlError(cause);
  c.header("cache-control", "no-store");

  return c.text(normalized.message, normalized.status);
}

async function rateLimitSaml(c: Context<AppEnv>) {
  if (
    !(await overRateLimit(
      c,
      "RATE_LIMIT_60",
      "saml-sso",
      clientAddress(c.req.raw)
    ))
  ) {
    return;
  }

  throw new SamlError("Too many SAML authentication attempts", 429);
}

async function samlStatusPostResponse(input: {
  configuration: SamlConfiguration;
  application: { acsUrl: string };
  request: Pick<ParsedSamlAuthnRequest, "id" | "relayState">;
  error: SamlStatusError;
}) {
  const { buildSamlErrorResponse, samlPostResponse } = await protocol();

  return samlPostResponse({
    acsUrl: input.application.acsUrl,
    samlResponse: buildSamlErrorResponse({
      configuration: input.configuration,
      acsUrl: input.application.acsUrl,
      spRequestId: input.request.id,
      statusCode: input.error.statusCode,
      message: input.error.message,
    }),
    relayState: input.request.relayState,
  });
}

export const samlLoginRoutes = new Hono<AppEnv>().get("/:id", async (c) => {
  try {
    const transaction = await browserSamlTransaction(
      createDb(c.env.DB),
      c,
      c.req.param("id")
    );

    return c.json({
      ok: true as const,
      transaction: { applicationName: transaction.applicationName },
    });
  } catch (error) {
    const normalized = samlError(error);

    if (normalized.status >= 500) throw error;

    const status =
      normalized.status === 403 ? 403 : normalized.status === 409 ? 409 : 400;

    return apiError(c, status, "BAD_REQUEST", normalized.message);
  }
});

export const samlRoutes = new Hono<AppEnv>()
  .get("/metadata", (c) => {
    try {
      const metadata = samlMetadata(samlConfiguration(c.env));
      c.header("cache-control", "public, max-age=3600");

      return c.body(metadata, 200, {
        "content-type": "application/samlmetadata+xml",
      });
    } catch (error) {
      return publicSamlError(c, error);
    }
  })
  .get("/sso", async (c) => {
    try {
      await rateLimitSaml(c);
      const configuration = samlConfiguration(c.env);

      const {
        findSamlApplicationByEntityId,
        issueSamlTransaction,
        parseRedirectAuthnRequest,
        validateAuthnRequestForApplication,
        verifyRedirectAuthnRequest,
      } = await protocol();

      const url = new URL(c.req.url);
      const request = parseRedirectAuthnRequest(url);
      const db = createDb(c.env.DB);

      const application = await findSamlApplicationByEntityId(
        db,
        request.issuer
      );

      const signed = verifyRedirectAuthnRequest(url, application);

      try {
        validateAuthnRequestForApplication(
          request,
          application,
          configuration.ssoUrl,
          signed
        );
      } catch (error) {
        if (!(error instanceof SamlStatusError)) throw error;

        return await samlStatusPostResponse({
          configuration,
          application,
          request,
          error,
        });
      }

      const session = await readSessionFromContext(c);

      if (request.isPassive && (!session || request.forceAuthn)) {
        return await samlStatusPostResponse({
          configuration,
          application,
          request,
          error: new SamlStatusError(
            "The principal cannot be authenticated passively",
            "urn:oasis:names:tc:SAML:2.0:status:NoPassive"
          ),
        });
      }

      const transaction = await createSamlTransaction(db, {
        applicationId: application.id,
        spRequestId: request.id,
        acsUrl: application.acsUrl,
        relayState: request.relayState,
        requestedSpNameQualifier: request.requestedSpNameQualifier,
        allowNameIdCreation: request.allowNameIdCreation,
        // ForceAuthn asks for a new sign-in even with a session.
        authenticated:
          session && !request.forceAuthn
            ? { userId: session.user.id, authTime: session.authTime }
            : undefined,
      });

      if (session && !request.forceAuthn) {
        return await issueSamlTransaction(
          db,
          c.env,
          transaction.id,
          session.user.id
        );
      }

      setSamlTransactionCookie(c, transaction);

      return c.redirect(
        `${SAML_LOGIN_PAGE}/${encodeURIComponent(transaction.id)}`
      );
    } catch (error) {
      return publicSamlError(c, error);
    }
  })
  .get("/launch/:id", async (c) => {
    try {
      await rateLimitSaml(c);
      samlConfiguration(c.env);

      const {
        assertUserCanUseSamlApplication,
        findSamlApplicationById,
        issueSamlTransaction,
      } = await protocol();

      const db = createDb(c.env.DB);
      const application = await findSamlApplicationById(db, c.req.param("id"));

      if (!application.allowIdpInitiated) {
        throw new SamlError(
          "IdP-initiated sign-in is disabled for this application",
          403
        );
      }

      // No RelayState from the link: anyone can craft a launch link, and the
      // app would treat its RelayState as where to send the person after
      // signing them in. The app picks its own landing page.
      const relayState = null;
      const session = await readSessionFromContext(c);

      if (session) {
        await assertUserCanUseSamlApplication(db, application, session.user.id);
      }

      const transaction = await createSamlTransaction(db, {
        applicationId: application.id,
        spRequestId: null,
        acsUrl: application.acsUrl,
        relayState,
        requestedSpNameQualifier: null,
        allowNameIdCreation: true,
        authenticated: session
          ? { userId: session.user.id, authTime: session.authTime }
          : undefined,
      });

      if (session) {
        return await issueSamlTransaction(
          db,
          c.env,
          transaction.id,
          session.user.id
        );
      }

      setSamlTransactionCookie(c, transaction);

      return c.redirect(
        `${SAML_LOGIN_PAGE}/${encodeURIComponent(transaction.id)}`
      );
    } catch (error) {
      return publicSamlError(c, error);
    }
  })
  .get("/resume/:id", async (c) => {
    try {
      const session = await readSessionFromContext(c);

      if (!session) throw new SamlError("Authentication is required", 403);
      const { issueSamlTransaction } = await protocol();

      return await issueSamlTransaction(
        createDb(c.env.DB),
        c.env,
        c.req.param("id"),
        session.user.id
      );
    } catch (error) {
      return publicSamlError(c, error);
    }
  });
