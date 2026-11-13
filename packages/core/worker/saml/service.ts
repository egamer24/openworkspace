import { and, eq, gt } from "drizzle-orm";

import { samlNameIdFormatUris } from "../../shared/saml";
import type { Database } from "../db/client";
import { mailboxAddressSql } from "../db/mailboxes";
import {
  teamMembership,
  teams,
  mailboxes,
  samlApplicationAccess,
  samlApplicationAccessTeams,
  samlApplications,
  samlAuthnRequests,
  samlPairwiseSubjects,
  users,
} from "../db/schema";
import type { AppEnv } from "../env";
import { createId } from "../lib/ids";
import { groupValues } from "../sso/access";
import { samlConfiguration } from "./configuration";
import { SamlError, SamlStatusError } from "./errors";
import {
  buildSamlErrorResponse,
  buildSamlResponse,
  samlPostResponse,
} from "./response";

const MAX_GROUP_CLAIMS = 100;

export type SamlApplication = typeof samlApplications.$inferSelect;

function withNameIdFormat(application: SamlApplication) {
  return {
    ...application,
    nameIdFormatUri: samlNameIdFormatUris[application.nameIdFormat],
  };
}

export async function findSamlApplicationByEntityId(
  db: Database,
  entityId: string
) {
  const [application] = await db
    .select()
    .from(samlApplications)
    .where(
      and(
        eq(samlApplications.entityId, entityId),
        eq(samlApplications.enabled, true)
      )
    )
    .limit(1);

  if (!application) throw new SamlError("Unknown or disabled SAML application");

  return withNameIdFormat(application);
}

export async function findSamlApplicationById(db: Database, id: string) {
  const [application] = await db
    .select()
    .from(samlApplications)
    .where(and(eq(samlApplications.id, id), eq(samlApplications.enabled, true)))
    .limit(1);

  if (!application) throw new SamlError("Unknown or disabled SAML application");

  return withNameIdFormat(application);
}

export async function assertUserCanUseSamlApplication(
  db: Database,
  application: SamlApplication,
  userId: string
) {
  const [user] = await db
    .select({ id: samlApplicationAccess.userId })
    .from(samlApplicationAccess)
    .where(
      and(
        eq(samlApplicationAccess.applicationId, application.id),
        eq(samlApplicationAccess.userId, userId)
      )
    )
    .limit(1);

  if (!user) {
    throw new SamlError(
      "You are not in a team that may use this application",
      403
    );
  }
}

async function samlIdentity(
  db: Database,
  application: Pick<SamlApplication, "id" | "nameIdFormat">,
  userId: string,
  allowNameIdCreation: boolean
) {
  const [identity, groups, persistentSubject] = await Promise.all([
    db
      .select({
        userId: users.id,
        name: users.name,
        email: mailboxAddressSql,
      })
      .from(users)
      .innerJoin(
        mailboxes,
        and(eq(mailboxes.ownerUserId, users.id), eq(mailboxes.isPrimary, true))
      )
      .where(and(eq(users.id, userId), eq(users.status, "active")))
      .limit(1),
    db
      .select({
        slug: teams.slug,
        everyone: teams.everyone,
        sentAs: samlApplicationAccessTeams.sentAs,
      })
      .from(teamMembership)
      .innerJoin(
        samlApplicationAccessTeams,
        and(
          eq(samlApplicationAccessTeams.teamId, teamMembership.teamId),
          eq(samlApplicationAccessTeams.applicationId, application.id)
        )
      )
      .innerJoin(teams, eq(teams.id, teamMembership.teamId))
      .where(eq(teamMembership.userId, userId))
      .limit(MAX_GROUP_CLAIMS + 1),
    application.nameIdFormat === "persistent"
      ? persistentSamlSubject(db, application.id, userId, allowNameIdCreation)
      : Promise.resolve(null),
  ]);

  if (!identity[0]) throw new SamlError("User identity is unavailable", 403);

  if (groups.length > MAX_GROUP_CLAIMS) {
    throw new SamlError("Group claim exceeds the configured limit", 500);
  }

  return {
    ...identity[0],
    nameId: persistentSubject ?? identity[0].email,
    groups: groupValues(groups),
  };
}

async function persistentSamlSubject(
  db: Database,
  applicationId: string,
  userId: string,
  allowCreate: boolean
) {
  const [existing] = await db
    .select({ nameId: samlPairwiseSubjects.nameId })
    .from(samlPairwiseSubjects)
    .where(
      and(
        eq(samlPairwiseSubjects.applicationId, applicationId),
        eq(samlPairwiseSubjects.userId, userId)
      )
    )
    .limit(1);

  if (existing) return existing.nameId;

  if (!allowCreate) {
    throw new SamlStatusError(
      "NameIDPolicy does not allow creating a persistent identifier",
      "urn:oasis:names:tc:SAML:2.0:status:InvalidNameIDPolicy"
    );
  }

  await db
    .insert(samlPairwiseSubjects)
    .values({
      applicationId,
      userId,
      nameId: createId("samlsub"),
    })
    .onConflictDoNothing();

  const [created] = await db
    .select({ nameId: samlPairwiseSubjects.nameId })
    .from(samlPairwiseSubjects)
    .where(
      and(
        eq(samlPairwiseSubjects.applicationId, applicationId),
        eq(samlPairwiseSubjects.userId, userId)
      )
    )
    .limit(1);

  if (!created) {
    throw new SamlError("Persistent SAML subject is unavailable", 500);
  }

  return created.nameId;
}

function issuanceStatusError(cause: unknown) {
  if (cause instanceof SamlStatusError) return cause;

  if (cause instanceof SamlError && cause.status === 403) {
    return new SamlStatusError(
      cause.message,
      "urn:oasis:names:tc:SAML:2.0:status:RequestDenied"
    );
  }

  return null;
}

export async function issueSamlTransaction(
  db: Database,
  env: AppEnv["Bindings"],
  requestId: string,
  expectedUserId: string
) {
  const now = new Date();

  const [transaction] = await db
    .select({
      id: samlAuthnRequests.id,
      applicationId: samlApplications.id,
      application: samlApplications,
      userId: samlAuthnRequests.userId,
      authTime: samlAuthnRequests.authTime,
      spRequestId: samlAuthnRequests.spRequestId,
      acsUrl: samlAuthnRequests.acsUrl,
      relayState: samlAuthnRequests.relayState,
      requestedSpNameQualifier: samlAuthnRequests.requestedSpNameQualifier,
      allowNameIdCreation: samlAuthnRequests.allowNameIdCreation,
    })
    .from(samlAuthnRequests)
    .innerJoin(
      samlApplications,
      eq(samlAuthnRequests.applicationId, samlApplications.id)
    )
    .where(
      and(
        eq(samlAuthnRequests.id, requestId),
        eq(samlAuthnRequests.userId, expectedUserId),
        eq(samlAuthnRequests.status, "authenticated"),
        eq(samlApplications.enabled, true),
        gt(samlAuthnRequests.expiresAt, now)
      )
    )
    .limit(1);

  if (!transaction?.userId || !transaction.authTime) {
    throw new SamlError("SAML transaction is invalid or expired");
  }

  if (transaction.acsUrl !== transaction.application.acsUrl) {
    throw new SamlError(
      "The application ACS URL changed during authentication"
    );
  }

  const configuration = samlConfiguration(env);
  let response: Response;
  let successful = false;

  try {
    await assertUserCanUseSamlApplication(
      db,
      transaction.application,
      transaction.userId
    );

    const identity = await samlIdentity(
      db,
      transaction.application,
      transaction.userId,
      transaction.allowNameIdCreation
    );

    const encodedResponse = buildSamlResponse({
      configuration,
      application: transaction.application,
      identity,
      authTime: transaction.authTime,
      transactionId: transaction.id,
      spRequestId: transaction.spRequestId,
      requestedSpNameQualifier: transaction.requestedSpNameQualifier,
      now,
    });

    response = samlPostResponse({
      acsUrl: transaction.acsUrl,
      samlResponse: encodedResponse,
      relayState: transaction.relayState,
    });
    successful = true;
  } catch (error) {
    const statusError = transaction.spRequestId
      ? issuanceStatusError(error)
      : null;

    if (!statusError || !transaction.spRequestId) throw error;
    response = samlPostResponse({
      acsUrl: transaction.acsUrl,
      samlResponse: buildSamlErrorResponse({
        configuration,
        acsUrl: transaction.acsUrl,
        spRequestId: transaction.spRequestId,
        statusCode: statusError.statusCode,
        message: statusError.message,
        now,
      }),
      relayState: transaction.relayState,
    });
  }

  const consume = db
    .update(samlAuthnRequests)
    .set({ status: "responded" })
    .where(
      and(
        eq(samlAuthnRequests.id, transaction.id),
        eq(samlAuthnRequests.status, "authenticated"),
        gt(samlAuthnRequests.expiresAt, now)
      )
    )
    .returning({ id: samlAuthnRequests.id });

  const [consumed] = successful
    ? await db.batch([
        consume,
        db
          .update(samlApplications)
          .set({ lastUsedAt: now })
          .where(eq(samlApplications.id, transaction.applicationId)),
      ])
    : await db.batch([consume]);

  if (consumed.length === 0) {
    throw new SamlError("SAML transaction was already completed", 409);
  }

  return response;
}
