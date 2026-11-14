import { X509Certificate } from "node:crypto";

import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";

import type { AccessLinkKind } from "../../shared/auth";
import {
  ACCESS_SCOPE,
  isPrivilegedScope,
  PEOPLE_READ_SCOPE,
  WORKSPACE_SCOPE,
} from "../../shared/oidc";
import { INVITATION_TTL_MS, RECOVERY_TTL_MS } from "../auth/constants";
import { requireAuth } from "../auth/middleware";
import { oauthScope, oauthScopeAnyOf } from "../auth/oauth-scopes";
import { actsAsAdministrator, requestPermissions } from "../auth/permissions";
import { personalAccountRecords } from "../auth/personal-account";
import { revokeUserAccess } from "../auth/revocation";
import {
  configuredMailDomains,
  mailDomainAllowed,
  mailDomainRefusal,
  unlistedMailboxDomains,
} from "../config/mail-domains";
import { createDb } from "../db/client";
import {
  mailboxAddressSql,
  mailboxKind,
  mailboxKindOrderSql,
} from "../db/mailboxes";
import {
  accessLinks,
  mailboxAccess,
  mailboxes,
  oidcAccessTokens,
  oidcAuthorizationCodes,
  oidcAuthorizationRequests,
  oidcClientAccessTeams,
  oidcClients,
  oidcGrants,
  oidcRefreshTokens,
  samlApplicationAccessTeams,
  samlApplications,
  teamMembers,
  teams,
  users,
} from "../db/schema";
import type { AppEnv } from "../env";
import { randomToken, hashToken } from "../lib/crypto";
import { apiError } from "../lib/http";
import { createId } from "../lib/ids";
import { zValidator } from "../lib/validator";
import { workspacePermissions } from "../modules";
import {
  clientBackchannelSessions,
  queueBackchannelLogouts,
} from "../oidc/backchannel-logout";
import { OIDC_ISSUER_PATHS } from "../oidc/constants";
import { oidcError } from "../oidc/errors";
import { oidcIssuer, publicJwks } from "../oidc/keys";
import { scopeInfo, workspaceScopeIds } from "../oidc/scopes";
import { insertOidcAudit } from "../oidc/service";
import { samlConfiguration, samlPublicUrls } from "../saml/configuration";
import { samlError } from "../saml/errors";
import { requestScimSync } from "../scim/sync";
import { revokeLostOidcAccess } from "../sso/access";
import {
  deferWebhookTask,
  mailboxWebhookData,
  queueMailboxWebhookEvent,
  queueUserWebhookEvent,
} from "../webhooks/service";
import { brandingAdminRoutes } from "../workspace-branding";
import { adminAccessGuard } from "./access-guard";
import {
  announceMailboxAccessChanged,
  mailboxAdminRoutes,
} from "./mailbox-routes";
import { rejectDeploymentManaged } from "./managed-apps";
import { mcpClientAdminRoutes } from "./mcp-client-routes";
import {
  provisioningAdminRoutes,
  provisioningSummaries,
} from "./provisioning-routes";
import { anotherActiveAdministratorRemains, hasKnownTeamIds } from "./records";
import { samlApplicationAdminRoutes } from "./saml-routes";
import {
  createInvitationSchema,
  createOidcClientSchema,
  updateOidcClientSchema,
  updateUserSchema,
} from "./schemas";
import { userSessionAdminRoutes } from "./session-routes";
import { guardUserTarget } from "./target-guard";
import { teamAdminRoutes } from "./team-routes";
import { webhookAdminRoutes } from "./webhook-routes";

type AdminSamlProvider = {
  configured: boolean;
  entityId: string | null;
  metadataUrl: string | null;
  ssoUrl: string | null;
  /** The signing certificate (public), PEM, for apps that want it pasted. */
  certificatePem: string | null;
  /** SHA-256 of the signing certificate, as colon-separated hex pairs. */
  certificateFingerprint: string | null;
  certificateExpiresAt: string | null;
  configurationError: string | null;
};

type AdminOidcProvider = {
  configured: boolean;
  issuer: string | null;
  discoveryUrl: string | null;
  authorizationUrl: string | null;
  tokenUrl: string | null;
  userinfoUrl: string | null;
  jwksUrl: string | null;
  endSessionUrl: string | null;
  configurationError: string | null;
};

/** What an app needs to talk to the OIDC provider, for the admin copy panel. */
async function adminOidcProvider(
  env: AppEnv["Bindings"]
): Promise<AdminOidcProvider> {
  let issuer: string;

  try {
    issuer = oidcIssuer(env);
  } catch (error) {
    return {
      configured: false,
      issuer: null,
      discoveryUrl: null,
      authorizationUrl: null,
      tokenUrl: null,
      userinfoUrl: null,
      jwksUrl: null,
      endSessionUrl: null,
      configurationError: oidcError(error).message,
    };
  }

  const urls = {
    issuer,
    discoveryUrl: new URL(OIDC_ISSUER_PATHS.discovery, issuer).toString(),
    authorizationUrl: new URL(
      OIDC_ISSUER_PATHS.authorization,
      issuer
    ).toString(),
    tokenUrl: new URL(OIDC_ISSUER_PATHS.token, issuer).toString(),
    userinfoUrl: new URL(OIDC_ISSUER_PATHS.userinfo, issuer).toString(),
    jwksUrl: new URL(OIDC_ISSUER_PATHS.jwks, issuer).toString(),
    endSessionUrl: new URL(OIDC_ISSUER_PATHS.logout, issuer).toString(),
  };

  try {
    await publicJwks(env);

    return { ...urls, configured: true, configurationError: null };
  } catch (error) {
    return {
      ...urls,
      configured: false,
      configurationError: oidcError(error).message,
    };
  }
}

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
      certificatePem: null,
      certificateFingerprint: null,
      certificateExpiresAt: null,
      configurationError: samlError(error).message,
    };
  }

  const publicUrls = {
    entityId: urls.entityId,
    metadataUrl: urls.metadataUrl,
    ssoUrl: urls.ssoUrl,
  };

  try {
    const certificate = new X509Certificate(
      samlConfiguration(env).certificatePem
    );

    return {
      ...publicUrls,
      configured: true,
      certificatePem: certificate.toString(),
      certificateFingerprint: certificate.fingerprint256,
      certificateExpiresAt: new Date(certificate.validTo).toISOString(),
      configurationError: null,
    };
  } catch (error) {
    return {
      ...publicUrls,
      configured: false,
      certificatePem: null,
      certificateFingerprint: null,
      certificateExpiresAt: null,
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
    input.now.getTime() +
      (input.kind === "invitation" ? INVITATION_TTL_MS : RECOVERY_TTL_MS)
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
        input.requestUrl
      ).toString(),
      expiresAt,
      userId: input.userId,
    },
  };
}

/** Admin sections whose changes can alter what SSO applications are provisioned with. */
const provisionedSections = new Set([
  "users",
  "invitations",
  "teams",
  "mailboxes",
  "oidc-clients",
  "saml-applications",
]);

export const adminRoutes = new Hono<AppEnv>()
  .use("*", requireAuth, adminAccessGuard)
  // Every route that names a person: the person must exist, and the caller
  // may act on them (target-guard.ts).
  .use("/users/:id/*", guardUserTarget("id"))
  .use("/teams/person/:id/*", guardUserTarget("id"))
  // What an app's OAuth token needs for each section (auth/oauth-scopes.ts).
  .use("/state", oauthScope(PEOPLE_READ_SCOPE))
  .use("/users/*", oauthScope("admin.people"))
  .use("/users/:id/access-link", oauthScope(ACCESS_SCOPE))
  .use("/invitations", oauthScope("admin.people"))
  // Personal mailboxes are people's, team addresses teams'; the routes check which.
  .use("/mailboxes/*", oauthScopeAnyOf("admin.people", "admin.teams"))
  .use("/teams/*", oauthScope("admin.teams"))
  .use("/oidc-clients/*", oauthScope("admin.apps"))
  .use("/saml-applications/*", oauthScope("admin.apps"))
  .use("/webhooks/*", oauthScope("admin.webhooks"))
  .use("/branding/*", oauthScope(WORKSPACE_SCOPE))
  // Ahead of every route, provisioning's included: apps declared in alchemy.run.ts are read-only here.
  .on(
    ["PATCH", "PUT", "DELETE", "POST"],
    ["/oidc-clients/:id", "/oidc-clients/:id/*"],
    rejectDeploymentManaged("oidc")
  )
  .on(
    ["PATCH", "PUT", "DELETE", "POST"],
    ["/saml-applications/:id", "/saml-applications/:id/*"],
    rejectDeploymentManaged("saml")
  )
  .use("*", async (c, next) => {
    await next();

    const section = new URL(c.req.url).pathname
      .replace(/^(?:\/api)?\/admin\//u, "")
      .split("/")[0];

    if (
      c.req.method === "GET" ||
      c.res.status >= 400 ||
      !provisionedSections.has(section ?? "")
    ) {
      return;
    }

    c.executionCtx.waitUntil(
      requestScimSync(c.env).catch((error) =>
        console.error("Could not request SCIM sync", error)
      )
    );
  })
  .get("/state", async (c) => {
    const db = createDb(c.env.DB);
    const permissions = new Set(requestPermissions(c));
    const canManageApps = permissions.has("manage_apps");

    const [
      unlistedDomains,
      userRows,
      mailboxRows,
      memberships,
      clientRows,
      clientAccessTeams,
      teamRows,
      teamMemberships,
      samlRows,
      samlAccessTeams,
    ] = await Promise.all([
      unlistedMailboxDomains(c.env.DB),
      db
        .select({
          id: users.id,
          name: users.name,
          avatarId: users.avatarId,
          role: users.role,
          status: users.status,
          permissions: users.permissions,
          createdAt: users.createdAt,
          personalEmail: mailboxAddressSql,
        })
        .from(users)
        .leftJoin(
          mailboxes,
          and(
            eq(mailboxes.ownerUserId, users.id),
            eq(mailboxes.isPrimary, true)
          )
        )
        .orderBy(desc(users.createdAt)),
      db
        .select({
          id: mailboxes.id,
          address: mailboxAddressSql,
          displayName: mailboxes.displayName,
          ownerUserId: mailboxes.ownerUserId,
          teamId: mailboxes.teamId,
          delivery: mailboxes.delivery,
          listPosting: mailboxes.listPosting,
          isPrimary: mailboxes.isPrimary,
          aliasOf: mailboxes.aliasOf,
          forwardTo: mailboxes.forwardTo,
          catchAll: mailboxes.catchAll,
          domain: mailboxes.domain,
          createdByUserId: mailboxes.createdByUserId,
          createdAt: mailboxes.createdAt,
          updatedAt: mailboxes.updatedAt,
        })
        .from(mailboxes)
        .orderBy(
          mailboxKindOrderSql,
          desc(mailboxes.isPrimary),
          mailboxes.displayName
        ),
      db
        .select({
          mailboxId: mailboxAccess.mailboxId,
          userId: mailboxAccess.userId,
          canSend: mailboxAccess.canSend,
        })
        .from(mailboxAccess),
      canManageApps
        ? db
            .select({
              id: oidcClients.id,
              name: oidcClients.name,
              clientType: oidcClients.clientType,
              redirectUris: oidcClients.redirectUris,
              postLogoutRedirectUris: oidcClients.postLogoutRedirectUris,
              backchannelLogoutUri: oidcClients.backchannelLogoutUri,
              allowedOrigins: oidcClients.allowedOrigins,
              allowedScopes: oidcClients.allowedScopes,
              trusted: oidcClients.trusted,
              enabled: oidcClients.enabled,
              requirePkce: oidcClients.requirePkce,
              managedBy: oidcClients.managedBy,
              lastUsedAt: oidcClients.lastUsedAt,
              createdAt: oidcClients.createdAt,
              updatedAt: oidcClients.updatedAt,
            })
            .from(oidcClients)
            // MCP clients register themselves and are managed by their users.
            .where(eq(oidcClients.registration, "admin"))
            .orderBy(oidcClients.name)
        : Promise.resolve([]),
      canManageApps
        ? db.select().from(oidcClientAccessTeams)
        : Promise.resolve([]),
      db.select().from(teams).orderBy(teams.name),
      db.select().from(teamMembers),
      canManageApps
        ? db
            .select({
              id: samlApplications.id,
              name: samlApplications.name,
              entityId: samlApplications.entityId,
              acsUrl: samlApplications.acsUrl,
              nameIdFormat: samlApplications.nameIdFormat,
              emailAttributeName: samlApplications.emailAttributeName,
              nameAttributeName: samlApplications.nameAttributeName,
              groupsAttributeName: samlApplications.groupsAttributeName,
              firstNameAttributeName: samlApplications.firstNameAttributeName,
              lastNameAttributeName: samlApplications.lastNameAttributeName,
              managedBy: samlApplications.managedBy,
              signResponse: samlApplications.signResponse,
              requireSignedAuthnRequests:
                samlApplications.requireSignedAuthnRequests,
              allowIdpInitiated: samlApplications.allowIdpInitiated,
              enabled: samlApplications.enabled,
              lastUsedAt: samlApplications.lastUsedAt,
              createdAt: samlApplications.createdAt,
              updatedAt: samlApplications.updatedAt,
            })
            .from(samlApplications)
            .orderBy(samlApplications.name)
        : Promise.resolve([]),
      canManageApps
        ? db.select().from(samlApplicationAccessTeams)
        : Promise.resolve([]),
    ]);

    const mailboxMembersById = groupByKey(
      memberships,
      (member) => member.mailboxId
    );

    const teamMembersById = groupByKey(
      teamMemberships,
      (membership) => membership.teamId
    );

    const clientAccessTeamsById = groupByKey(
      clientAccessTeams,
      (row) => row.clientId
    );

    const samlAccessTeamsById = groupByKey(
      samlAccessTeams,
      (row) => row.applicationId
    );

    const provisioning: Awaited<ReturnType<typeof provisioningSummaries>> =
      canManageApps ? await provisioningSummaries(db) : new Map();

    const samlProvider = adminSamlProvider(c.env);
    const oidcProvider = await adminOidcProvider(c.env);

    return c.json({
      ok: true as const,
      permissions: [...permissions],
      /** Everything a member can be given: core's permissions and the modules'. */
      availablePermissions: [...workspacePermissions()],
      /** Workspace scopes an administrator may let an app ask for, besides identity. */
      availableScopes: scopeInfo(workspaceScopeIds()),
      /** Mail domains (`mailDomains` in alchemy.run.ts), primary first: where new addresses may go. */
      mailDomains: configuredMailDomains(),
      /**
       * Domains of existing addresses that `mailDomains` no longer lists. Those
       * addresses keep working; no new address can be created on them.
       */
      unlistedMailDomains: unlistedDomains,
      users: userRows,
      mailboxes: mailboxRows.map((mailbox) => ({
        ...mailbox,
        kind: mailboxKind(mailbox.ownerUserId),
        members: (mailboxMembersById.get(mailbox.id) ?? []).map(
          ({ userId, canSend }) => ({ userId, canSend })
        ),
      })),
      teams: teamRows.map((team) => ({
        ...team,
        members: (teamMembersById.get(team.id) ?? []).map(
          ({ userId, canSend }) => ({ userId, canSend })
        ),
      })),
      oidcProvider,
      oidcClients: clientRows.map((client) => ({
        ...client,
        accessTeams: (clientAccessTeamsById.get(client.id) ?? []).map(
          ({ teamId, sentAs }) => ({ teamId, sentAs })
        ),
        provisioning: provisioning.get(`oidc:${client.id}`) ?? null,
      })),
      samlProvider,
      samlApplications: samlRows.map((application) => ({
        ...application,
        accessTeams: (samlAccessTeamsById.get(application.id) ?? []).map(
          ({ teamId, sentAs }) => ({ teamId, sentAs })
        ),
        provisioning: provisioning.get(`saml:${application.id}`) ?? null,
        launchUrl: samlProvider.entityId
          ? new URL(
              `/saml/launch/${application.id}`,
              samlProvider.entityId
            ).toString()
          : null,
      })),
    });
  })
  .route("/", userSessionAdminRoutes)
  .route("/", provisioningAdminRoutes)
  .route("/", samlApplicationAdminRoutes)
  .route("/", mailboxAdminRoutes)
  .post(
    "/invitations",
    zValidator("json", createInvitationSchema),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);

      if (!mailDomainAllowed(input.email)) {
        return apiError(c, 400, "BAD_REQUEST", mailDomainRefusal());
      }

      const admin = c.get("user");
      const userId = createId("usr");
      const mailboxId = createId("mbx");
      const now = new Date();

      const account = personalAccountRecords({
        userId,
        mailboxId,
        name: input.name,
        email: input.email,
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
          db.insert(accessLinks).values(invitation.values),
        ]);
      } catch {
        return apiError(c, 409, "CONFLICT", "Email address is already in use");
      }

      const webhookMailbox = await mailboxWebhookData(db, mailboxId);

      if (webhookMailbox) {
        deferWebhookTask(
          (task) => c.executionCtx.waitUntil(task),
          (eventId) =>
            queueMailboxWebhookEvent(
              c.env,
              "mailbox.created",
              webhookMailbox,
              eventId
            )
        );
      }

      return c.json({ ok: true as const, accessLink: invitation.result }, 201);
    }
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
        "Enable the account before creating a recovery link"
      );
    }

    const admin = c.get("user");
    const now = new Date();

    const kind: AccessLinkKind =
      target.status === "invited" ? "invitation" : "recovery";

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
            isNull(accessLinks.consumedAt)
          )
        ),
      db.insert(accessLinks).values(accessLink.values),
    ] as const);

    return c.json(
      {
        ok: true as const,
        accessLink: accessLink.result,
      },
      201
    );
  })
  .patch("/users/:id", zValidator("json", updateUserSchema), async (c) => {
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
        "You cannot disable your own account"
      );
    }

    if (input.role !== undefined && !actsAsAdministrator(c, ACCESS_SCOPE)) {
      return apiError(
        c,
        403,
        "FORBIDDEN",
        "Only administrators can change who is an administrator"
      );
    }

    if (
      input.permissions !== undefined &&
      !actsAsAdministrator(c, ACCESS_SCOPE)
    ) {
      return apiError(
        c,
        403,
        "FORBIDDEN",
        "Only administrators can change what people may manage"
      );
    }

    if (input.role === "member" && userId === c.get("user").id) {
      return apiError(
        c,
        400,
        "BAD_REQUEST",
        "You cannot remove your own administrator role"
      );
    }

    const now = new Date();
    const nameChanged = input.name !== undefined && input.name !== target.name;

    // Demoting or disabling an administrator needs another active one to
    // remain. The condition is part of the UPDATE, so two such changes
    // running at once cannot both pass it.
    const removesAdministrator =
      input.role === "member" || input.status === "disabled";

    const [updated] = await db
      .update(users)
      .set({
        // Drizzle leaves the columns of omitted (undefined) fields unchanged.
        name: input.name,
        role: input.role,
        permissions: input.permissions,
        status: input.status,
        updatedAt: now,
      })
      .where(
        and(
          eq(users.id, userId),
          removesAdministrator
            ? anotherActiveAdministratorRemains(userId)
            : undefined
        )
      )
      .returning({ id: users.id });

    if (!updated) {
      return apiError(
        c,
        409,
        "CONFLICT",
        "The workspace needs another active administrator first"
      );
    }

    const personalMailboxUpdate =
      input.name !== undefined && nameChanged
        ? db
            .update(mailboxes)
            .set({
              displayName: input.name,
              updatedAt: now,
            })
            .where(
              and(
                eq(mailboxes.ownerUserId, userId),
                eq(mailboxes.isPrimary, true)
              )
            )
        : null;

    if (input.status === "disabled" && target.status !== "disabled") {
      await revokeUserAccess(c.env, db, userId, {
        alongside: personalMailboxUpdate ? [personalMailboxUpdate] : [],
        defer: (task) => c.executionCtx.waitUntil(task),
      });
      await announceMailboxAccessChanged(c.env, (task) =>
        c.executionCtx.waitUntil(task)
      );
    } else if (personalMailboxUpdate) {
      await personalMailboxUpdate;
    }

    deferWebhookTask(
      (task) => c.executionCtx.waitUntil(task),
      (eventId) => queueUserWebhookEvent(c.env, "user.updated", userId, eventId)
    );

    if (nameChanged) {
      const [personalMailbox] = await db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(
          and(eq(mailboxes.ownerUserId, userId), eq(mailboxes.isPrimary, true))
        )
        .limit(1);

      if (personalMailbox) {
        const webhookMailbox = await mailboxWebhookData(db, personalMailbox.id);

        if (webhookMailbox) {
          deferWebhookTask(
            (task) => c.executionCtx.waitUntil(task),
            (eventId) =>
              queueMailboxWebhookEvent(
                c.env,
                "mailbox.updated",
                webhookMailbox,
                eventId
              )
          );
        }
      }
    }

    return c.json({ ok: true as const });
  })
  .post(
    "/oidc-clients",
    zValidator("json", createOidcClientSchema),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const refused = privilegedClientRefusal(c, input);

      if (refused) return refused;

      if (
        !(await hasKnownTeamIds(
          db,
          input.accessTeams.map((team) => team.teamId)
        ))
      ) {
        return apiError(c, 400, "BAD_REQUEST", "Unknown team");
      }

      const id = createId("cli");

      const clientSecret =
        input.clientType === "confidential"
          ? `owsec_${randomToken()}`
          : undefined;

      const now = new Date();

      const accessInsert =
        input.accessTeams.length > 0
          ? db
              .insert(oidcClientAccessTeams)
              .values(
                input.accessTeams.map((team) => ({ clientId: id, ...team }))
              )
          : null;

      try {
        await db.batch([
          db.insert(oidcClients).values({
            id,
            name: input.name,
            clientType: input.clientType,
            secretHash: clientSecret ? await hashToken(clientSecret) : null,
            redirectUris: input.redirectUris,
            postLogoutRedirectUris: input.postLogoutRedirectUris,
            backchannelLogoutUri: input.backchannelLogoutUri,
            allowedOrigins: input.allowedOrigins,
            allowedScopes: input.allowedScopes,
            trusted: input.trusted,
            enabled: input.enabled,
            requirePkce: input.clientType === "public" || input.requirePkce,
            createdByUserId: c.get("user").id,
            createdAt: now,
            updatedAt: now,
          }),
          ...(accessInsert ? [accessInsert] : []),
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
        201
      );
    }
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
          trusted: oidcClients.trusted,
        })
        .from(oidcClients)
        .where(
          and(
            eq(oidcClients.id, clientId),
            eq(oidcClients.registration, "admin")
          )
        )
        .limit(1);

      if (!client) {
        return apiError(c, 404, "NOT_FOUND", "OIDC client not found");
      }

      const refused = privilegedClientRefusal(c, input, client);

      if (refused) return refused;

      if (client.clientType !== input.clientType) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          "Client type cannot be changed after creation"
        );
      }

      if (
        !(await hasKnownTeamIds(
          db,
          input.accessTeams.map((team) => team.teamId)
        ))
      ) {
        return apiError(c, 400, "BAD_REQUEST", "Unknown team");
      }

      const now = new Date();
      const requestedScopes = new Set<string>(input.allowedScopes);

      const revokeAll =
        !input.enabled ||
        client.allowedScopes.some((scope) => !requestedScopes.has(scope));

      const loggedOut = revokeAll
        ? await clientBackchannelSessions(db, clientId)
        : [];

      const accessInsert =
        input.accessTeams.length > 0
          ? db
              .insert(oidcClientAccessTeams)
              .values(input.accessTeams.map((team) => ({ clientId, ...team })))
          : null;

      await db.batch([
        db
          .update(oidcClients)
          .set({
            name: input.name,
            clientType: input.clientType,
            redirectUris: input.redirectUris,
            postLogoutRedirectUris: input.postLogoutRedirectUris,
            backchannelLogoutUri: input.backchannelLogoutUri,
            allowedOrigins: input.allowedOrigins,
            allowedScopes: input.allowedScopes,
            trusted: input.trusted,
            enabled: input.enabled,
            requirePkce: input.clientType === "public" || input.requirePkce,
            updatedAt: now,
          })
          .where(eq(oidcClients.id, clientId)),
        db
          .delete(oidcClientAccessTeams)
          .where(eq(oidcClientAccessTeams.clientId, clientId)),
        ...(accessInsert ? [accessInsert] : []),
        db
          .delete(oidcAuthorizationRequests)
          .where(eq(oidcAuthorizationRequests.clientId, clientId)),
        db
          .delete(oidcAuthorizationCodes)
          .where(eq(oidcAuthorizationCodes.clientId, clientId)),
        ...(revokeAll
          ? [
              db
                .delete(oidcAccessTokens)
                .where(eq(oidcAccessTokens.clientId, clientId)),
              db
                .delete(oidcRefreshTokens)
                .where(eq(oidcRefreshTokens.clientId, clientId)),
              db.delete(oidcGrants).where(eq(oidcGrants.clientId, clientId)),
            ]
          : []),
        insertOidcAudit(db, {
          eventType: "client.updated",
          actorUserId: c.get("user").id,
          clientId,
        }),
      ]);

      if (loggedOut.length) {
        c.executionCtx.waitUntil(
          queueBackchannelLogouts(c.env, loggedOut).catch((error) =>
            console.error("Could not queue back-channel logout", error)
          )
        );
      } else {
        // People outside the teams now admitted are signed out of the app.
        await revokeLostOidcAccess(c.env, clientId);
      }

      return c.json({ ok: true as const });
    }
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
      .where(
        and(eq(oidcClients.id, clientId), eq(oidcClients.registration, "admin"))
      )
      .limit(1);

    if (!client) return apiError(c, 404, "NOT_FOUND", "OIDC client not found");

    if (client.type !== "confidential") {
      return apiError(
        c,
        400,
        "BAD_REQUEST",
        "Public clients do not use secrets"
      );
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
  .route("/", teamAdminRoutes)
  .route("/", mcpClientAdminRoutes)
  .route("/webhooks", webhookAdminRoutes)
  .route("/branding", brandingAdminRoutes);

/**
 * Skipping consent, and scopes that reach mail or administration, are for
 * administrators to give an app: an app manager could otherwise hand an app
 * of theirs everyone's mail. What the app already has may stay as it is.
 */
function privilegedClientRefusal(
  c: Context<AppEnv>,
  input: { trusted: boolean; allowedScopes: readonly string[] },
  current?: { trusted: boolean; allowedScopes: readonly string[] }
) {
  if (actsAsAdministrator(c, ACCESS_SCOPE)) return null;

  if (input.trusted && !current?.trusted) {
    return apiError(
      c,
      403,
      "FORBIDDEN",
      "Only administrators can let an app skip the consent screen"
    );
  }

  const added = input.allowedScopes.filter(
    (scope) =>
      isPrivilegedScope(scope) && !current?.allowedScopes.includes(scope)
  );

  if (added.length) {
    return apiError(
      c,
      403,
      "FORBIDDEN",
      "Only administrators can let an app ask for mail or administration access"
    );
  }

  return null;
}

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
