import { zValidator } from "@hono/zod-validator";
import {
  and,
  desc,
  eq,
  isNull,
  notInArray,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { Hono } from "hono";
import type { AccessLinkKind } from "../../shared/auth";
import { requireAdmin, requireAuth } from "../auth/middleware";
import { createDb } from "../db/client";
import {
  accessLinks,
  accountApiTokens,
  authChallenges,
  domainOnboardingSteps,
  domains,
  groupMembers,
  identityGroups,
  mailboxMembers,
  mailboxes,
  oidcAccessTokens,
  oidcAuthorizationCodes,
  oidcAuthorizationRequests,
  oidcClientAssignments,
  oidcClientGroupClaims,
  oidcClients,
  oidcGrants,
  oidcRefreshTokens,
  pushSubscriptions,
  samlApplicationAssignments,
  samlApplicationGroupClaims,
  samlApplications,
  samlAuthnRequests,
  sessions,
  users,
} from "../db/schema";
import type { AppEnv } from "../env";
import {
  globalAiProcessingEnabled,
  setGlobalAiProcessingEnabled,
} from "../ai/configuration";
import { randomToken, hashToken } from "../lib/crypto";
import { apiError } from "../lib/http";
import { createId } from "../lib/ids";
import {
  INVITATION_TTL_MS,
  RECOVERY_TTL_MS,
} from "../auth/constants";
import { personalAccountRecords } from "../auth/personal-account";
import {
  createInvitationSchema,
  createOidcClientSchema,
  globalAiProcessingSchema,
  groupInputSchema,
  updateOidcClientSchema,
  updateUserSchema,
} from "./schemas";
import { insertOidcAudit } from "../oidc/service";
import { webhookAdminRoutes } from "./webhook-routes";
import { backupAdminRoutes } from "./backup-routes";
import {
  deferWebhookTask,
  mailboxWebhookData,
  queueMailboxWebhookEvent,
  queueUserWebhookEvent,
} from "../webhooks/service";
import {
  mailboxAddressSql,
  mailboxKind,
  mailboxKindOrderSql,
} from "../db/mailboxes";
import { cloudflareAdminRoutes } from "./cloudflare-routes";
import { domainAdminRoutes } from "./domain-routes";
import { mailboxAdminRoutes } from "./mailbox-routes";
import { routingAdminRoutes } from "./routing-routes";
import {
  domainForAddress,
  hasKnownGroupIds,
  hasKnownUserIds,
} from "./records";
import { userSessionAdminRoutes } from "./session-routes";
import { samlApplicationAdminRoutes } from "./saml-routes";
import { samlConfiguration, samlPublicUrls } from "../saml/configuration";
import { samlError } from "../saml/errors";

type AdminSamlProvider = {
  configured: boolean;
  entityId: string | null;
  metadataUrl: string | null;
  ssoUrl: string | null;
  configurationError: string | null;
};

function adminSamlProvider(env: AppEnv["Bindings"]): AdminSamlProvider {
  let urls: ReturnType<typeof samlPublicUrls>;
  try {
    urls = samlPublicUrls(env);
  } catch (error) {
    return {
      configured: false,
      entityId: null,
      metadataUrl: null,
      ssoUrl: null,
      configurationError: samlError(error).message,
    };
  }
  const publicUrls = {
    entityId: urls.entityId,
    metadataUrl: urls.metadataUrl,
    ssoUrl: urls.ssoUrl,
  };

  try {
    samlConfiguration(env);
    return { ...publicUrls, configured: true, configurationError: null };
  } catch (error) {
    return {
      ...publicUrls,
      configured: false,
      configurationError: samlError(error).message,
    };
  }
}

async function prepareAccessLink(input: {
  kind: AccessLinkKind;
  userId: string;
  createdByUserId: string;
  requestUrl: string;
  now: Date;
}) {
  const token = randomToken();
  const expiresAt = new Date(
    input.now.getTime()
      + (input.kind === "invitation" ? INVITATION_TTL_MS : RECOVERY_TTL_MS),
  );
  return {
    values: {
      id: createId("lnk"),
      kind: input.kind,
      userId: input.userId,
      tokenHash: await hashToken(token),
      createdByUserId: input.createdByUserId,
      expiresAt,
      createdAt: input.now,
    },
    result: {
      kind: input.kind,
      url: new URL(
        `/${input.kind === "invitation" ? "invite" : "recover"}/${token}`,
        input.requestUrl,
      ).toString(),
      expiresAt,
      userId: input.userId,
    },
  };
}

export const adminRoutes = new Hono<AppEnv>()
  .use("*", requireAuth, requireAdmin)
  .get("/state", async (c) => {
    const db = createDb(c.env.DB);
    const [
      aiProcessingEnabled,
      domainRows,
      userRows,
      mailboxRows,
      memberships,
      clientRows,
      clientAssignments,
      groupRows,
      groupMemberships,
      clientGroupClaims,
      samlRows,
      samlAssignments,
      samlGroupClaims,
      onboardingSteps,
    ] = await Promise.all([
      globalAiProcessingEnabled(c.env.DB),
      db
        .select({
          id: domains.id,
          name: domains.name,
          cloudflareZoneId: domains.cloudflareZoneId,
          isPrimary: domains.isPrimary,
          createdAt: domains.createdAt,
          updatedAt: domains.updatedAt,
        })
        .from(domains)
        .orderBy(desc(domains.isPrimary), domains.name),
      db
        .select({
          id: users.id,
          name: users.name,
          avatarUrl: users.avatarUrl,
          role: users.role,
          status: users.status,
          createdAt: users.createdAt,
          personalEmail: mailboxAddressSql,
        })
        .from(users)
        .leftJoin(
          mailboxes,
          and(
            eq(mailboxes.ownerUserId, users.id),
            eq(mailboxes.isPrimary, true),
          ),
        )
        .leftJoin(domains, eq(mailboxes.domainId, domains.id))
        .orderBy(desc(users.createdAt)),
      db
        .select({
          id: mailboxes.id,
          address: mailboxAddressSql,
          displayName: mailboxes.displayName,
          ownerUserId: mailboxes.ownerUserId,
          isPrimary: mailboxes.isPrimary,
          domainId: mailboxes.domainId,
          createdByUserId: mailboxes.createdByUserId,
          createdAt: mailboxes.createdAt,
          updatedAt: mailboxes.updatedAt,
        })
        .from(mailboxes)
        .innerJoin(domains, eq(mailboxes.domainId, domains.id))
        .orderBy(
          mailboxKindOrderSql,
          desc(mailboxes.isPrimary),
          mailboxes.displayName,
        ),
      db
        .select({
          mailboxId: mailboxMembers.mailboxId,
          userId: mailboxMembers.userId,
          canSend: mailboxMembers.canSend,
        })
        .from(mailboxMembers),
      db.select({
        id: oidcClients.id,
        name: oidcClients.name,
        clientType: oidcClients.clientType,
        accessPolicy: oidcClients.accessPolicy,
        redirectUris: oidcClients.redirectUris,
        postLogoutRedirectUris: oidcClients.postLogoutRedirectUris,
        allowedOrigins: oidcClients.allowedOrigins,
        allowedScopes: oidcClients.allowedScopes,
        trusted: oidcClients.trusted,
        enabled: oidcClients.enabled,
        lastUsedAt: oidcClients.lastUsedAt,
        createdAt: oidcClients.createdAt,
        updatedAt: oidcClients.updatedAt,
      }).from(oidcClients).orderBy(oidcClients.name),
      db.select().from(oidcClientAssignments),
      db.select().from(identityGroups).orderBy(identityGroups.name),
      db.select().from(groupMembers),
      db.select().from(oidcClientGroupClaims),
      db.select({
        id: samlApplications.id,
        name: samlApplications.name,
        entityId: samlApplications.entityId,
        acsUrl: samlApplications.acsUrl,
        nameIdFormat: samlApplications.nameIdFormat,
        accessPolicy: samlApplications.accessPolicy,
        emailAttributeName: samlApplications.emailAttributeName,
        nameAttributeName: samlApplications.nameAttributeName,
        groupsAttributeName: samlApplications.groupsAttributeName,
        signResponse: samlApplications.signResponse,
        requireSignedAuthnRequests: samlApplications.requireSignedAuthnRequests,
        allowIdpInitiated: samlApplications.allowIdpInitiated,
        enabled: samlApplications.enabled,
        lastUsedAt: samlApplications.lastUsedAt,
        createdAt: samlApplications.createdAt,
        updatedAt: samlApplications.updatedAt,
      }).from(samlApplications).orderBy(samlApplications.name),
      db.select().from(samlApplicationAssignments),
      db.select().from(samlApplicationGroupClaims),
      db.select().from(domainOnboardingSteps),
    ]);
    const mailboxMembersById = groupByKey(
      memberships,
      (member) => member.mailboxId,
    );
    const groupMembersById = mapGroupedValues(
      groupMemberships,
      (membership) => membership.groupId,
      (membership) => membership.userId,
    );
    const clientAssignmentsById = mapGroupedValues(
      clientAssignments,
      (assignment) => assignment.clientId,
      (assignment) => assignment.userId,
    );
    const clientGroupClaimsById = mapGroupedValues(
      clientGroupClaims,
      (claim) => claim.clientId,
      (claim) => claim.groupId,
    );
    const samlAssignmentsById = mapGroupedValues(
      samlAssignments,
      (assignment) => assignment.applicationId,
      (assignment) => assignment.userId,
    );
    const samlGroupClaimsById = mapGroupedValues(
      samlGroupClaims,
      (claim) => claim.applicationId,
      (claim) => claim.groupId,
    );
    const onboardingStepsById = groupByKey(
      onboardingSteps,
      (step) => step.domainId,
    );
    const samlProvider = adminSamlProvider(c.env);
    return c.json({
      ok: true as const,
      aiProcessingEnabled,
      cloudflareOnboarding: Boolean(c.env.CLOUDFLARE_API_TOKEN),
      domains: domainRows.map((domain) => ({
        ...domain,
        onboarding: (onboardingStepsById.get(domain.id) ?? []).map(
          ({ step, status, detail, updatedAt }) => ({ step, status, detail, updatedAt }),
        ),
      })),
      users: userRows,
      mailboxes: mailboxRows.map((mailbox) => ({
        ...mailbox,
        kind: mailboxKind(mailbox.ownerUserId),
        members: (mailboxMembersById.get(mailbox.id) ?? []).map(
          ({ userId, canSend }) => ({ userId, canSend }),
        ),
      })),
      groups: groupRows.map((group) => ({
        ...group,
        memberIds: groupMembersById.get(group.id) ?? [],
      })),
      oidcClients: clientRows.map((client) => ({
        ...client,
        assignedUserIds: clientAssignmentsById.get(client.id) ?? [],
        exposedGroupIds: clientGroupClaimsById.get(client.id) ?? [],
      })),
      samlProvider,
      samlApplications: samlRows.map((application) => ({
        ...application,
        assignedUserIds: samlAssignmentsById.get(application.id) ?? [],
        exposedGroupIds: samlGroupClaimsById.get(application.id) ?? [],
        launchUrl: samlProvider.entityId
          ? new URL(`/saml/launch/${application.id}`, samlProvider.entityId).toString()
          : null,
      })),
    });
  })
  .route("/", userSessionAdminRoutes)
  .route("/", domainAdminRoutes)
  .route("/", cloudflareAdminRoutes)
  .route("/", routingAdminRoutes)
  .route("/", samlApplicationAdminRoutes)
  .put(
    "/ai",
    zValidator("json", globalAiProcessingSchema),
    async (c) => {
      const setting = await setGlobalAiProcessingEnabled(
        c.env.DB,
        c.req.valid("json").enabled,
      );
      return c.json({
        ok: true as const,
        enabled: setting.enabled,
      });
    },
  )
  .route("/", mailboxAdminRoutes)
  .route("/", backupAdminRoutes)
  .post(
    "/invitations",
    zValidator("json", createInvitationSchema),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const domain = await domainForAddress(db, input.email);
      if (!domain) {
        return apiError(c, 400, "BAD_REQUEST", "Personal mailbox domain is not configured");
      }
      const admin = c.get("user");
      const userId = createId("usr");
      const mailboxId = createId("mbx");
      const now = new Date();
      const account = personalAccountRecords({
        userId,
        mailboxId,
        domainId: domain.id,
        name: input.name,
        email: input.email,
        avatarUrl: null,
        role: "member",
        status: "invited",
        createdByUserId: admin.id,
        now,
      });
      const invitation = await prepareAccessLink({
        kind: "invitation",
        userId,
        createdByUserId: admin.id,
        requestUrl: c.req.url,
        now,
      });

      try {
        await db.batch([
          db.insert(users).values(account.user),
          db.insert(mailboxes).values(account.mailbox),
          db.insert(mailboxMembers).values(account.membership),
          db.insert(accessLinks).values(invitation.values),
        ]);
      } catch {
        return apiError(c, 409, "CONFLICT", "Email address is already in use");
      }

      const webhookMailbox = await mailboxWebhookData(db, mailboxId);
      if (webhookMailbox) {
        deferWebhookTask(
          (task) => c.executionCtx.waitUntil(task),
          (eventId) => queueMailboxWebhookEvent(
            c.env,
            "mailbox.created",
            webhookMailbox,
            eventId,
          ),
        );
      }

      return c.json(
        { ok: true as const, accessLink: invitation.result },
        201,
      );
    },
  )
  .post("/users/:id/access-link", async (c) => {
    const db = createDb(c.env.DB);
    const userId = c.req.param("id");
    const [target] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!target) return apiError(c, 404, "NOT_FOUND", "User not found");
    if (target.status === "disabled") {
      return apiError(
        c,
        400,
        "BAD_REQUEST",
        "Enable the account before creating a recovery link",
      );
    }

    const admin = c.get("user");
    const now = new Date();
    const kind: AccessLinkKind = target.status === "invited"
      ? "invitation"
      : "recovery";
    const accessLink = await prepareAccessLink({
      kind,
      userId,
      createdByUserId: admin.id,
      requestUrl: c.req.url,
      now,
    });
    await db.batch([
      db
        .delete(accessLinks)
        .where(
          and(
            eq(accessLinks.userId, userId),
            eq(accessLinks.kind, kind),
            isNull(accessLinks.consumedAt),
          ),
        ),
      db.insert(accessLinks).values(accessLink.values),
    ] as const);

    return c.json(
      {
        ok: true as const,
        accessLink: accessLink.result,
      },
      201,
    );
  })
  .patch(
    "/users/:id",
    zValidator("json", updateUserSchema),
    async (c) => {
      const db = createDb(c.env.DB);
      const userId = c.req.param("id");
      const input = c.req.valid("json");
      const [target] = await db
        .select({
          id: users.id,
          name: users.name,
          status: users.status,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!target) return apiError(c, 404, "NOT_FOUND", "User not found");
      if (input.status === "disabled" && userId === c.get("user").id) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          "You cannot disable your own account",
        );
      }
      if (input.role === "member" && userId === c.get("user").id) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          "You cannot remove your own administrator role",
        );
      }

      const now = new Date();
      const nameChanged = input.name !== undefined && input.name !== target.name;
      const userUpdate = db
        .update(users)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          updatedAt: now,
        })
        .where(eq(users.id, userId));
      const personalMailboxUpdate = input.name !== undefined && nameChanged
        ? db
          .update(mailboxes)
          .set({
            displayName: input.name,
            updatedAt: now,
          })
          .where(and(
            eq(mailboxes.ownerUserId, userId),
            eq(mailboxes.isPrimary, true),
          ))
        : null;
      if (input.status === "disabled" && target.status !== "disabled") {
        const revocations = [
          db.delete(accountApiTokens).where(eq(accountApiTokens.userId, userId)),
          db.delete(sessions).where(eq(sessions.userId, userId)),
          db
            .delete(pushSubscriptions)
            .where(eq(pushSubscriptions.userId, userId)),
          db.delete(authChallenges).where(eq(authChallenges.userId, userId)),
          db
            .delete(accessLinks)
            .where(
              and(
                eq(accessLinks.userId, userId),
                isNull(accessLinks.consumedAt),
              ),
            ),
          db
            .delete(oidcAuthorizationRequests)
            .where(eq(oidcAuthorizationRequests.userId, userId)),
          db
            .delete(oidcAuthorizationCodes)
            .where(eq(oidcAuthorizationCodes.userId, userId)),
          db
            .delete(oidcAccessTokens)
            .where(eq(oidcAccessTokens.userId, userId)),
          db
            .delete(oidcRefreshTokens)
            .where(eq(oidcRefreshTokens.userId, userId)),
          db.delete(oidcGrants).where(eq(oidcGrants.userId, userId)),
          db
            .delete(samlAuthnRequests)
            .where(eq(samlAuthnRequests.userId, userId)),
        ] as const;
        if (personalMailboxUpdate) {
          await db.batch([userUpdate, personalMailboxUpdate, ...revocations]);
        } else {
          await db.batch([userUpdate, ...revocations]);
        }
      } else if (personalMailboxUpdate) {
        await db.batch([userUpdate, personalMailboxUpdate]);
      } else {
        await userUpdate;
      }
      deferWebhookTask(
        (task) => c.executionCtx.waitUntil(task),
        (eventId) => queueUserWebhookEvent(
          c.env,
          "user.updated",
          userId,
          eventId,
        ),
      );
      if (nameChanged) {
        const [personalMailbox] = await db
          .select({ id: mailboxes.id })
          .from(mailboxes)
          .where(and(
            eq(mailboxes.ownerUserId, userId),
            eq(mailboxes.isPrimary, true),
          ))
          .limit(1);
        if (personalMailbox) {
          const webhookMailbox = await mailboxWebhookData(db, personalMailbox.id);
          if (webhookMailbox) {
            deferWebhookTask(
              (task) => c.executionCtx.waitUntil(task),
              (eventId) => queueMailboxWebhookEvent(
                c.env,
                "mailbox.updated",
                webhookMailbox,
                eventId,
              ),
            );
          }
        }
      }
      return c.json({ ok: true as const });
    },
  )
  .post(
    "/oidc-clients",
    zValidator("json", createOidcClientSchema),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      if (!(await hasKnownUserIds(db, input.assignedUserIds))) {
        return apiError(c, 400, "BAD_REQUEST", "Unknown assigned user");
      }
      if (!(await hasKnownGroupIds(db, input.exposedGroupIds))) {
        return apiError(c, 400, "BAD_REQUEST", "Unknown exposed group");
      }
      const id = createId("cli");
      const clientSecret = input.clientType === "confidential"
        ? `owsec_${randomToken()}`
        : undefined;
      const now = new Date();
      const assignmentInsert = input.assignedUserIds.length > 0
        ? db.insert(oidcClientAssignments).values(
          input.assignedUserIds.map((userId) => ({
            clientId: id,
            userId,
            createdAt: now,
          })),
        )
        : null;
      const groupClaimInsert = input.exposedGroupIds.length > 0
        ? db.insert(oidcClientGroupClaims).values(
          input.exposedGroupIds.map((groupId) => ({
            clientId: id,
            groupId,
          })),
        )
        : null;
      try {
        await db.batch([
          db.insert(oidcClients).values({
            id,
            name: input.name,
            clientType: input.clientType,
            secretHash: clientSecret ? await hashToken(clientSecret) : null,
            accessPolicy: input.accessPolicy,
            redirectUris: input.redirectUris,
            postLogoutRedirectUris: input.postLogoutRedirectUris,
            allowedOrigins: input.allowedOrigins,
            allowedScopes: input.allowedScopes,
            trusted: input.trusted,
            enabled: input.enabled,
            createdByUserId: c.get("user").id,
            createdAt: now,
            updatedAt: now,
          }),
          ...(assignmentInsert ? [assignmentInsert] : []),
          ...(groupClaimInsert ? [groupClaimInsert] : []),
          insertOidcAudit(db, {
            eventType: "client.created",
            actorUserId: c.get("user").id,
            clientId: id,
          }),
        ]);
      } catch {
        return apiError(c, 409, "CONFLICT", "OIDC client could not be created");
      }
      return c.json(
        {
          ok: true as const,
          clientId: id,
          clientSecret,
        },
        201,
      );
    },
  )
  .patch(
    "/oidc-clients/:id",
    zValidator("json", updateOidcClientSchema),
    async (c) => {
      const input = c.req.valid("json");
      const clientId = c.req.param("id");
      const db = createDb(c.env.DB);
      const [client] = await db
        .select({
          id: oidcClients.id,
          clientType: oidcClients.clientType,
          allowedScopes: oidcClients.allowedScopes,
        })
        .from(oidcClients)
        .where(eq(oidcClients.id, clientId))
        .limit(1);
      if (!client) return apiError(c, 404, "NOT_FOUND", "OIDC client not found");
      if (client.clientType !== input.clientType) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          "Client type cannot be changed after creation",
        );
      }
      if (!(await hasKnownUserIds(db, input.assignedUserIds))) {
        return apiError(c, 400, "BAD_REQUEST", "Unknown assigned user");
      }
      if (!(await hasKnownGroupIds(db, input.exposedGroupIds))) {
        return apiError(c, 400, "BAD_REQUEST", "Unknown exposed group");
      }

      const now = new Date();
      const requestedScopes = new Set<string>(input.allowedScopes);
      const revokeAll =
        !input.enabled ||
        client.allowedScopes.some(
          (scope) => !requestedScopes.has(scope),
        );
      const revokeUnassigned =
        !revokeAll && input.accessPolicy === "selected_users";
      const accessTokenRevocation = clientScopedUserRevocation(
        oidcAccessTokens.clientId,
        oidcAccessTokens.userId,
        clientId,
        input.assignedUserIds,
        revokeAll,
        revokeUnassigned,
      );
      const refreshTokenRevocation = clientScopedUserRevocation(
        oidcRefreshTokens.clientId,
        oidcRefreshTokens.userId,
        clientId,
        input.assignedUserIds,
        revokeAll,
        revokeUnassigned,
      );
      const grantRevocation = clientScopedUserRevocation(
        oidcGrants.clientId,
        oidcGrants.userId,
        clientId,
        input.assignedUserIds,
        revokeAll,
        revokeUnassigned,
      );
      const assignmentInsert = input.assignedUserIds.length > 0
        ? db.insert(oidcClientAssignments).values(
          input.assignedUserIds.map((userId) => ({
            clientId,
            userId,
            createdAt: now,
          })),
        )
        : null;
      const groupClaimInsert = input.exposedGroupIds.length > 0
        ? db.insert(oidcClientGroupClaims).values(
          input.exposedGroupIds.map((groupId) => ({ clientId, groupId })),
        )
        : null;
      await db.batch([
        db
          .update(oidcClients)
          .set({
            name: input.name,
            clientType: input.clientType,
            accessPolicy: input.accessPolicy,
            redirectUris: input.redirectUris,
            postLogoutRedirectUris: input.postLogoutRedirectUris,
            allowedOrigins: input.allowedOrigins,
            allowedScopes: input.allowedScopes,
            trusted: input.trusted,
            enabled: input.enabled,
            updatedAt: now,
          })
          .where(eq(oidcClients.id, clientId)),
        db
          .delete(oidcClientAssignments)
          .where(eq(oidcClientAssignments.clientId, clientId)),
        db
          .delete(oidcClientGroupClaims)
          .where(eq(oidcClientGroupClaims.clientId, clientId)),
        db
          .delete(oidcAuthorizationRequests)
          .where(eq(oidcAuthorizationRequests.clientId, clientId)),
        db
          .delete(oidcAuthorizationCodes)
          .where(eq(oidcAuthorizationCodes.clientId, clientId)),
        ...(accessTokenRevocation
          ? [db.delete(oidcAccessTokens).where(accessTokenRevocation)]
          : []),
        ...(refreshTokenRevocation
          ? [db.delete(oidcRefreshTokens).where(refreshTokenRevocation)]
          : []),
        ...(grantRevocation
          ? [db.delete(oidcGrants).where(grantRevocation)]
          : []),
        ...(assignmentInsert ? [assignmentInsert] : []),
        ...(groupClaimInsert ? [groupClaimInsert] : []),
        insertOidcAudit(db, {
          eventType: "client.updated",
          actorUserId: c.get("user").id,
          clientId,
        }),
      ]);
      return c.json({ ok: true as const });
    },
  )
  .delete("/oidc-clients/:id", async (c) => {
    const db = createDb(c.env.DB);
    const clientId = c.req.param("id");
    const [client] = await db
      .select({ id: oidcClients.id })
      .from(oidcClients)
      .where(eq(oidcClients.id, clientId))
      .limit(1);
    if (!client) return apiError(c, 404, "NOT_FOUND", "OIDC client not found");
    await db.batch([
      db.delete(oidcClients).where(eq(oidcClients.id, clientId)),
      insertOidcAudit(db, {
        eventType: "client.deleted",
        actorUserId: c.get("user").id,
        clientId,
      }),
    ]);
    return c.json({ ok: true as const });
  })
  .post("/oidc-clients/:id/rotate-secret", async (c) => {
    const db = createDb(c.env.DB);
    const clientId = c.req.param("id");
    const [client] = await db
      .select({ type: oidcClients.clientType })
      .from(oidcClients)
      .where(eq(oidcClients.id, clientId))
      .limit(1);
    if (!client) return apiError(c, 404, "NOT_FOUND", "OIDC client not found");
    if (client.type !== "confidential") {
      return apiError(c, 400, "BAD_REQUEST", "Public clients do not use secrets");
    }
    const clientSecret = `owsec_${randomToken()}`;
    await db.batch([
      db
        .update(oidcClients)
        .set({
          secretHash: await hashToken(clientSecret),
          updatedAt: new Date(),
        })
        .where(eq(oidcClients.id, clientId)),
      insertOidcAudit(db, {
        eventType: "client.secret_rotated",
        actorUserId: c.get("user").id,
        clientId,
      }),
    ]);
    return c.json({ ok: true as const, clientSecret });
  })
  .post(
    "/groups",
    zValidator("json", groupInputSchema),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      if (!(await hasKnownUserIds(db, input.memberIds))) {
        return apiError(c, 400, "BAD_REQUEST", "Unknown group member");
      }
      const id = createId("grp");
      const now = new Date();
      const memberInsert = input.memberIds.length > 0
        ? db.insert(groupMembers).values(
          input.memberIds.map((userId) => ({
            groupId: id,
            userId,
            createdAt: now,
          })),
        )
        : null;
      try {
        await db.batch([
          db.insert(identityGroups).values({
            id,
            name: input.name,
            slug: input.slug,
            description: input.description,
            createdByUserId: c.get("user").id,
            createdAt: now,
            updatedAt: now,
          }),
          ...(memberInsert ? [memberInsert] : []),
          insertOidcAudit(db, {
            eventType: "group.created",
            actorUserId: c.get("user").id,
            detail: { groupId: id },
          }),
        ]);
      } catch {
        return apiError(c, 409, "CONFLICT", "Group slug is already in use");
      }
      return c.json({ ok: true as const, groupId: id }, 201);
    },
  )
  .patch(
    "/groups/:id",
    zValidator("json", groupInputSchema),
    async (c) => {
      const input = c.req.valid("json");
      const groupId = c.req.param("id");
      const db = createDb(c.env.DB);
      if (!(await hasKnownUserIds(db, input.memberIds))) {
        return apiError(c, 400, "BAD_REQUEST", "Unknown group member");
      }
      const [group] = await db
        .select({ id: identityGroups.id })
        .from(identityGroups)
        .where(eq(identityGroups.id, groupId))
        .limit(1);
      if (!group) return apiError(c, 404, "NOT_FOUND", "Group not found");
      const now = new Date();
      const memberInsert = input.memberIds.length > 0
        ? db.insert(groupMembers).values(
          input.memberIds.map((userId) => ({
            groupId,
            userId,
            createdAt: now,
          })),
        )
        : null;
      try {
        await db.batch([
          db
            .update(identityGroups)
            .set({
              name: input.name,
              slug: input.slug,
              description: input.description,
              updatedAt: now,
            })
            .where(eq(identityGroups.id, groupId)),
          db.delete(groupMembers).where(eq(groupMembers.groupId, groupId)),
          ...(memberInsert ? [memberInsert] : []),
          insertOidcAudit(db, {
            eventType: "group.updated",
            actorUserId: c.get("user").id,
            detail: { groupId },
          }),
        ]);
      } catch {
        return apiError(c, 409, "CONFLICT", "Group slug is already in use");
      }
      return c.json({ ok: true as const });
    },
  )
  .delete("/groups/:id", async (c) => {
    const db = createDb(c.env.DB);
    const groupId = c.req.param("id");
    const [group] = await db
      .select({ id: identityGroups.id })
      .from(identityGroups)
      .where(eq(identityGroups.id, groupId))
      .limit(1);
    if (!group) return apiError(c, 404, "NOT_FOUND", "Group not found");
    await db.batch([
      db.delete(identityGroups).where(eq(identityGroups.id, groupId)),
      insertOidcAudit(db, {
        eventType: "group.deleted",
        actorUserId: c.get("user").id,
        detail: { groupId },
      }),
    ]);
    return c.json({ ok: true as const });
  })
  .route("/webhooks", webhookAdminRoutes);

function groupByKey<T>(items: T[], key: (item: T) => string) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const list = map.get(id);
    if (list) list.push(item);
    else map.set(id, [item]);
  }
  return map;
}

function mapGroupedValues<T>(
  items: T[],
  key: (item: T) => string,
  value: (item: T) => string,
) {
  const map = new Map<string, string[]>();
  for (const item of items) {
    const id = key(item);
    const list = map.get(id);
    if (list) list.push(value(item));
    else map.set(id, [value(item)]);
  }
  return map;
}

function clientScopedUserRevocation(
  clientIdColumn: AnyColumn,
  userIdColumn: AnyColumn,
  clientId: string,
  assignedUserIds: string[],
  revokeAll: boolean,
  revokeUnassigned: boolean,
): SQL | undefined {
  if (revokeAll || (revokeUnassigned && assignedUserIds.length === 0)) {
    return eq(clientIdColumn, clientId);
  }
  if (revokeUnassigned) {
    return and(
      eq(clientIdColumn, clientId),
      notInArray(userIdColumn, assignedUserIds),
    );
  }
  return undefined;
}
