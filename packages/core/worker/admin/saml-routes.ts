import { X509Certificate } from "node:crypto";

import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { createDb } from "../db/client";
import {
  samlApplicationAccessTeams,
  samlApplications,
  samlAuthnRequests,
} from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { createId } from "../lib/ids";
import { zValidator } from "../lib/validator";
import { samlConfiguration } from "../saml/configuration";
import { SP_METADATA_MAX_BYTES } from "../saml/constants";
import { isSupportedSamlRsaKey } from "../saml/credentials";
import {
  ENTITY_ID_LOCKED_MESSAGE,
  entityIdLocked,
  lockedEntityId,
} from "../saml/entity-id";
import { samlError } from "../saml/errors";
import { hasKnownTeamIds } from "./records";
import {
  createSamlApplicationSchema,
  updateSamlApplicationSchema,
} from "./schemas";

function validCertificate(value: string | null) {
  if (!value) return null;

  try {
    const certificate = new X509Certificate(value);

    return isSupportedSamlRsaKey(certificate.publicKey)
      ? certificate.toString()
      : null;
  } catch {
    return null;
  }
}

async function validateReferences(
  db: ReturnType<typeof createDb>,
  input: { accessTeams: { teamId: string }[] }
) {
  return (await hasKnownTeamIds(
    db,
    input.accessTeams.map((team) => team.teamId)
  ))
    ? null
    : "Unknown team";
}

function accessTeamRows(
  db: ReturnType<typeof createDb>,
  applicationId: string,
  accessTeams: { teamId: string; sentAs: string | null }[]
) {
  return accessTeams.length
    ? [
        db
          .insert(samlApplicationAccessTeams)
          .values(accessTeams.map((team) => ({ applicationId, ...team }))),
      ]
    : [];
}

const parseMetadataSchema = z.union([
  z.object({ url: z.string().trim().min(1).max(2048) }),
  z.object({ xml: z.string().min(1).max(SP_METADATA_MAX_BYTES) }),
]);

export const samlApplicationAdminRoutes = new Hono<AppEnv>()
  /** This identity provider's signing certificate, to upload into an app. */
  .get(
    "/saml-applications/idp-certificate",
    zValidator(
      "query",
      z.object({ format: z.enum(["pem", "cer"]).default("pem") })
    ),
    (c) => {
      let pem: string;

      try {
        pem = samlConfiguration(c.env).certificatePem;
      } catch (error) {
        return apiError(c, 503, "UNAVAILABLE", samlError(error).message);
      }

      const certificate = new X509Certificate(pem);
      const { format } = c.req.valid("query");
      c.header("cache-control", "no-store");
      c.header(
        "content-disposition",
        `attachment; filename="openworkspace-saml.${format}"`
      );

      return format === "pem"
        ? c.body(certificate.toString(), 200, {
            "content-type": "application/x-pem-file",
          })
        : c.body(new Uint8Array(certificate.raw), 200, {
            "content-type": "application/pkix-cert",
          });
    }
  )
  /** Reads a service provider's metadata, from its address or the file itself. */
  .post(
    "/saml-applications/parse-metadata",
    zValidator("json", parseMetadataSchema),
    async (c) => {
      const input = c.req.valid("json");

      try {
        // Loaded here: it parses XML, which few requests need.
        const { fetchSpMetadata, parseSpMetadata } =
          await import("../saml/sp-metadata");

        const xml =
          "url" in input ? await fetchSpMetadata(input.url) : input.xml;

        return c.json({ ok: true as const, draft: parseSpMetadata(xml) });
      } catch (error) {
        const normalized = samlError(error);

        if (normalized.status >= 500) throw error;

        return apiError(c, 400, "BAD_REQUEST", normalized.message);
      }
    }
  )
  .get("/saml-applications/:id", async (c) => {
    const [application] = await createDb(c.env.DB)
      .select({
        spSigningCertificate: samlApplications.spSigningCertificate,
      })
      .from(samlApplications)
      .where(eq(samlApplications.id, c.req.param("id")))
      .limit(1);

    if (!application) {
      return apiError(c, 404, "NOT_FOUND", "SAML application not found");
    }

    return c.json({ ok: true as const, ...application });
  })
  .post(
    "/saml-applications",
    zValidator("json", createSamlApplicationSchema),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const referenceError = await validateReferences(db, input);

      if (referenceError) {
        return apiError(c, 400, "BAD_REQUEST", referenceError);
      }

      const certificate = validCertificate(input.spSigningCertificate);

      if (input.spSigningCertificate && !certificate) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          "Service-provider certificate is invalid"
        );
      }

      const id = createId("sapp");
      const now = new Date();

      try {
        await db.batch([
          db.insert(samlApplications).values({
            id,
            name: input.name,
            entityId: input.entityId,
            acsUrl: input.acsUrl,
            nameIdFormat: input.nameIdFormat,
            emailAttributeName: input.emailAttributeName,
            nameAttributeName: input.nameAttributeName,
            groupsAttributeName: input.groupsAttributeName,
            firstNameAttributeName: input.firstNameAttributeName,
            lastNameAttributeName: input.lastNameAttributeName,
            signResponse: input.signResponse,
            requireSignedAuthnRequests: input.requireSignedAuthnRequests,
            spSigningCertificate: certificate,
            allowIdpInitiated: input.allowIdpInitiated,
            enabled: input.enabled,
            createdByUserId: c.get("user").id,
            createdAt: now,
            updatedAt: now,
          }),
          ...accessTeamRows(db, id, input.accessTeams),
        ]);
      } catch (error) {
        const [conflict] = await db
          .select({ id: samlApplications.id })
          .from(samlApplications)
          .where(eq(samlApplications.entityId, input.entityId))
          .limit(1);

        if (conflict) {
          return apiError(
            c,
            409,
            "CONFLICT",
            "SAML Entity ID is already registered"
          );
        }

        throw error;
      }

      return c.json({ ok: true as const, applicationId: id }, 201);
    }
  )
  .patch(
    "/saml-applications/:id",
    zValidator("json", updateSamlApplicationSchema),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const applicationId = c.req.param("id");

      const [application] = await db
        .select({ id: samlApplications.id })
        .from(samlApplications)
        .where(eq(samlApplications.id, applicationId))
        .limit(1);

      if (!application) {
        return apiError(c, 404, "NOT_FOUND", "SAML application not found");
      }

      const referenceError = await validateReferences(db, input);

      if (referenceError) {
        return apiError(c, 400, "BAD_REQUEST", referenceError);
      }

      const certificate = validCertificate(input.spSigningCertificate);

      if (input.spSigningCertificate && !certificate) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          "Service-provider certificate is invalid"
        );
      }

      const now = new Date();

      try {
        await db.batch([
          db
            .update(samlApplications)
            .set({
              name: input.name,
              entityId: lockedEntityId(input.entityId),
              acsUrl: input.acsUrl,
              nameIdFormat: input.nameIdFormat,
              emailAttributeName: input.emailAttributeName,
              nameAttributeName: input.nameAttributeName,
              groupsAttributeName: input.groupsAttributeName,
              firstNameAttributeName: input.firstNameAttributeName,
              lastNameAttributeName: input.lastNameAttributeName,
              signResponse: input.signResponse,
              requireSignedAuthnRequests: input.requireSignedAuthnRequests,
              spSigningCertificate: certificate,
              allowIdpInitiated: input.allowIdpInitiated,
              enabled: input.enabled,
              updatedAt: now,
            })
            .where(eq(samlApplications.id, applicationId)),
          db
            .delete(samlApplicationAccessTeams)
            .where(eq(samlApplicationAccessTeams.applicationId, applicationId)),
          db
            .delete(samlAuthnRequests)
            .where(
              and(
                eq(samlAuthnRequests.applicationId, applicationId),
                ne(samlAuthnRequests.status, "responded")
              )
            ),
          ...accessTeamRows(db, applicationId, input.accessTeams),
        ]);
      } catch (error) {
        if (entityIdLocked(error)) {
          return apiError(c, 409, "CONFLICT", ENTITY_ID_LOCKED_MESSAGE);
        }

        const [conflict] = await db
          .select({ id: samlApplications.id })
          .from(samlApplications)
          .where(
            and(
              eq(samlApplications.entityId, input.entityId),
              ne(samlApplications.id, applicationId)
            )
          )
          .limit(1);

        if (conflict) {
          return apiError(
            c,
            409,
            "CONFLICT",
            "SAML Entity ID is already registered"
          );
        }

        throw error;
      }

      return c.json({ ok: true as const });
    }
  )
  .delete("/saml-applications/:id", async (c) => {
    const db = createDb(c.env.DB);
    const applicationId = c.req.param("id");

    const removed = await db
      .delete(samlApplications)
      .where(eq(samlApplications.id, applicationId))
      .returning({ id: samlApplications.id });

    if (removed.length === 0) {
      return apiError(c, 404, "NOT_FOUND", "SAML application not found");
    }

    return c.json({ ok: true as const });
  });
