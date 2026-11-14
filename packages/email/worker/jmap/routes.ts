import {
  bearerToken,
  createDb,
  describeIssues,
  mailboxAddressSql,
  mailboxAccess,
  mailboxes,
  overRateLimit,
  authenticateAccessToken,
  jmapProtectedResourceMetadataUrl,
  jmapResourceUri,
  oidcIssuer,
} from "@open-workspace/core/module";
import type { AppEnv } from "@open-workspace/core/module";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";

import { MAX_COMPOSER_ATTACHMENT_BYTES } from "../../shared/mail";
import { JMAP_PATH } from "../../shared/module";
import {
  MAIL_ORGANIZE_SCOPE,
  MAIL_READ_SCOPE,
  MAIL_SEND_SCOPE,
  mailScopes,
} from "../../shared/permissions";
import { vapidConfiguration } from "../mail/push-notifications";
import {
  createComposerUploadIntent,
  finalizeComposerUpload,
  loadComposerUpload,
  storeComposerUploadContent,
  UploadValidationError,
} from "../mail/uploads";
import { mailboxStub } from "../mailbox";
import { jmapEventStream } from "./eventsource";
import {
  JmapError,
  jmapRequestSchema,
  runJmapRequest,
  UPLOAD_BLOB,
} from "./methods";
import type { JmapAccount, JmapContext } from "./methods";

const CAPABILITIES = {
  "urn:ietf:params:jmap:core": {
    maxSizeUpload: MAX_COMPOSER_ATTACHMENT_BYTES,
    maxConcurrentUpload: 1,
    maxSizeRequest: 10_000_000,
    maxConcurrentRequests: 4,
    maxCallsInRequest: 32,
    maxObjectsInGet: 500,
    maxObjectsInSet: 500,
    collationAlgorithms: ["i;unicode-casemap"],
  },
  "urn:ietf:params:jmap:mail": {},
  "urn:ietf:params:jmap:submission": {},
};

type SessionCapabilities = typeof CAPABILITIES & {
  /** RFC 9749: push services that require VAPID accept our pushes. */
  "urn:ietf:params:jmap:webpush-vapid"?: { applicationServerKey: string };
};

const MAIL_ACCOUNT_CAPABILITY = {
  maxMailboxesPerEmail: 1,
  maxMailboxDepth: 1,
  maxSizeMailboxName: 80,
  maxSizeAttachmentsPerEmail: MAX_COMPOSER_ATTACHMENT_BYTES,
  emailQuerySortOptions: ["receivedAt", "sentAt"],
  mayCreateTopLevelMailbox: false,
};

type AccountCapabilities = {
  "urn:ietf:params:jmap:mail": typeof MAIL_ACCOUNT_CAPABILITY;
  /** Only accounts the person can send from. */
  "urn:ietf:params:jmap:submission"?: {
    maxDelayedSend: number;
    submissionExtensions: Record<string, never>;
  };
};

function accountCapabilities(account: JmapAccount) {
  const capabilities: AccountCapabilities = {
    "urn:ietf:params:jmap:mail": MAIL_ACCOUNT_CAPABILITY,
  };

  if (account.canSend) {
    capabilities["urn:ietf:params:jmap:submission"] = {
      maxDelayedSend: 0,
      submissionExtensions: {},
    };
  }

  return capabilities;
}

const mailScopeNames: ReadonlySet<string> = new Set(mailScopes);

type JmapUser = {
  id: string;
  name: string;
  clientId: string;
  token: string;
  /** The token's mail scopes the person may still use. */
  scopes: readonly string[];
};

type JmapEnv = AppEnv & {
  Variables: AppEnv["Variables"] & { jmapUser: JmapUser };
};

function problem(
  c: Context,
  status: 400 | 401 | 403 | 404 | 413 | 429,
  type: string,
  detail: string
) {
  return c.json({ type, status, detail }, status, {
    "content-type": "application/problem+json",
  });
}

/** The mailboxes this person can open; each is a JMAP account. */
export async function jmapAccounts(
  env: Env,
  userId: string
): Promise<JmapAccount[]> {
  const rows = await createDb(env.DB)
    .select({
      id: mailboxes.id,
      address: mailboxAddressSql,
      displayName: mailboxes.displayName,
      ownerUserId: mailboxes.ownerUserId,
      isPrimary: mailboxes.isPrimary,
      canSend: mailboxAccess.canSend,
    })
    .from(mailboxAccess)
    .innerJoin(mailboxes, eq(mailboxAccess.mailboxId, mailboxes.id))
    .where(
      and(eq(mailboxAccess.userId, userId), eq(mailboxes.delivery, "inbox"))
    );

  return rows.map((row) => ({
    ...row,
    isPersonal: row.ownerUserId === userId,
  }));
}

function sessionObject(
  origin: string,
  user: { id: string; name: string },
  accounts: JmapAccount[],
  vapidPublicKey: string | null
) {
  const primary =
    accounts.find((account) => account.isPersonal && account.isPrimary) ??
    accounts.find((account) => account.isPersonal) ??
    accounts[0];

  const capabilities: SessionCapabilities = { ...CAPABILITIES };

  if (vapidPublicKey) {
    capabilities["urn:ietf:params:jmap:webpush-vapid"] = {
      applicationServerKey: vapidPublicKey,
    };
  }

  return {
    capabilities,
    accounts: Object.fromEntries(
      accounts.map((account) => [
        account.id,
        {
          name: account.address,
          isPersonal: account.isPersonal,
          isReadOnly: false,
          accountCapabilities: accountCapabilities(account),
        },
      ])
    ),
    primaryAccounts: primary
      ? {
          "urn:ietf:params:jmap:mail": primary.id,
          "urn:ietf:params:jmap:submission": primary.id,
        }
      : {},
    username: primary?.address ?? user.name,
    apiUrl: `${origin}${JMAP_PATH}/api`,
    downloadUrl: `${origin}${JMAP_PATH}/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `${origin}${JMAP_PATH}/upload/{accountId}`,
    eventSourceUrl: `${origin}${JMAP_PATH}/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
    state: String(accounts.length),
  };
}

/** RFC 8707: JMAP accepts only tokens issued for it, at the issuer's origin or this one. */
function jmapResources(c: Context<JmapEnv>) {
  const origins = new Set([new URL(c.req.url).origin]);

  try {
    origins.add(new URL(oidcIssuer(c.env)).origin);
  } catch {
    // Without a configured issuer, only this origin.
  }

  return [...origins].map(jmapResourceUri);
}

/** Who a JMAP token signs in, with its mail scopes; null when it is not good here. */
async function jmapIdentity(c: Context<JmapEnv>, token: string) {
  const identity = await authenticateAccessToken(
    createDb(c.env.DB),
    token,
    jmapResources(c)
  );

  if (!identity) return null;

  return {
    ...identity,
    scopes: identity.scopes.filter((scope) => mailScopeNames.has(scope)),
  };
}

const requireJmapAuth = async (
  c: Context<JmapEnv>,
  next: () => Promise<void>
) => {
  const token = bearerToken(c.req.raw);
  const identity = token ? await jmapIdentity(c, token) : null;

  if (!token || !identity) {
    c.header(
      "www-authenticate",
      [
        `Bearer resource_metadata="${jmapProtectedResourceMetadataUrl(new URL(c.req.url).origin)}"`,
        `scope="${mailScopes.join(" ")}"`,
        ...(token ? ['error="invalid_token"'] : []),
      ].join(", ")
    );

    return problem(
      c,
      401,
      "about:blank",
      token ? "The access token is invalid or expired" : "Sign in with OAuth"
    );
  }

  if (!identity.scopes.length) {
    c.header(
      "www-authenticate",
      `Bearer error="insufficient_scope", scope="${mailScopes.join(" ")}"`
    );

    return problem(
      c,
      403,
      "about:blank",
      "This token was not given access to mail"
    );
  }

  c.set("jmapUser", {
    id: identity.user.id,
    name: identity.user.name,
    clientId: identity.clientId,
    token,
    scopes: identity.scopes,
  });
  await next();
};

/** A 403 unless the token holds `scope`. */
function missingScope(c: Context<JmapEnv>, scope: string) {
  if (c.get("jmapUser").scopes.includes(scope)) return null;
  c.header(
    "www-authenticate",
    `Bearer error="insufficient_scope", scope="${scope}"`
  );

  return problem(c, 403, "about:blank", `This token was not given ${scope}`);
}

/**
 * JMAP (RFC 8620) for mail (RFC 8621) with OAuth bearer tokens issued for
 * it, each method allowed by its mail scope (methods.ts). Each mailbox the
 * person can open is a JMAP account.
 */
export const jmapRoutes = new Hono<JmapEnv>()
  .get("/.well-known/jmap", (c) => c.redirect(`${JMAP_PATH}/session`, 302))
  .use(`${JMAP_PATH}/*`, requireJmapAuth)
  .get(`${JMAP_PATH}/session`, async (c) => {
    const user = c.get("jmapUser");
    const vapid = await vapidConfiguration(c.env);

    return c.json(
      sessionObject(
        new URL(c.req.url).origin,
        user,
        await jmapAccounts(c.env, user.id),
        vapid?.publicKey ?? null
      )
    );
  })
  .post(`${JMAP_PATH}/api`, async (c) => {
    if (
      !c.req
        .header("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    ) {
      return problem(
        c,
        400,
        "urn:ietf:params:jmap:error:notJSON",
        "The request must be JSON"
      );
    }

    let body: unknown;

    try {
      body = await c.req.json();
    } catch {
      return problem(
        c,
        400,
        "urn:ietf:params:jmap:error:notJSON",
        "The request is not valid JSON"
      );
    }

    const request = jmapRequestSchema.safeParse(body);

    if (!request.success) {
      return problem(
        c,
        400,
        "urn:ietf:params:jmap:error:notRequest",
        describeIssues(request.error.issues)
      );
    }

    const user = c.get("jmapUser");

    const context: JmapContext = {
      env: c.env,
      user: { id: user.id, name: user.name },
      clientId: user.clientId,
      scopes: user.scopes,
      vapid: await vapidConfiguration(c.env),
      accounts: await jmapAccounts(c.env, user.id),
      requestUrl: c.req.url,
      defer: (task) => c.executionCtx.waitUntil(task),
    };

    try {
      return c.json(await runJmapRequest(context, request.data));
    } catch (error) {
      if (error instanceof JmapError) {
        return problem(c, 400, error.type, error.message);
      }

      throw error;
    }
  })
  .get(`${JMAP_PATH}/download/:accountId/:blobId/:name`, async (c) => {
    const refused = missingScope(c, MAIL_READ_SCOPE);

    if (refused) return refused;
    const user = c.get("jmapUser");

    const account = (await jmapAccounts(c.env, user.id)).find(
      (item) => item.id === c.req.param("accountId")
    );

    if (!account) return problem(c, 404, "about:blank", "Account not found");
    const blobId = c.req.param("blobId");
    const upload = UPLOAD_BLOB.exec(blobId);
    const blob = /^(raw|att)~([^~]+)(?:~(.+))?$/u.exec(blobId);
    let key: string | null | undefined;

    if (upload) {
      key = await loadComposerUpload({
        env: c.env,
        mailboxId: account.id,
        userId: user.id,
        uploadId: upload[1],
      }).then(
        (found) => found.r2Key,
        () => null
      );
    } else if (blob) {
      const [, kind, emailId, attachmentId] = blob;
      const email = await mailboxStub(c.env, account.id).getEmail(emailId);
      key =
        kind === "raw"
          ? email?.rawMimeR2Key
          : email?.attachmentsJson.find(
              (attachment) => attachment.id === attachmentId
            )?.r2Key;
    }

    const object = key ? await c.env.MAIL_STORAGE.get(key) : null;

    if (!object) return problem(c, 404, "about:blank", "Blob not found");

    const type =
      c.req.query("type") ||
      object.httpMetadata?.contentType ||
      (blob?.[1] === "raw" ? "message/rfc822" : "application/octet-stream");

    return new Response(object.body, {
      headers: {
        "content-type": type,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(c.req.param("name"))}`,
        "cache-control": "private, immutable, max-age=31536000",
      },
    });
  })
  .post(`${JMAP_PATH}/upload/:accountId`, async (c) => {
    const user = c.get("jmapUser");

    const account = (await jmapAccounts(c.env, user.id)).find(
      (item) => item.id === c.req.param("accountId")
    );

    // Uploads become attachments of mail being sent, or messages imported
    // into the person's own mailbox (Email/import, like moving mail there).
    const imports =
      account?.isPersonal === true && user.scopes.includes(MAIL_ORGANIZE_SCOPE);

    const refused = imports ? null : missingScope(c, MAIL_SEND_SCOPE);

    if (refused) return refused;

    if (!account) return problem(c, 404, "about:blank", "Account not found");

    if (!imports && !account.canSend) {
      return problem(c, 403, "about:blank", "This account cannot send");
    }

    const rateExceeded = await overRateLimit(
      c,
      "RATE_LIMIT_30",
      "mail-upload",
      user.id
    );

    if (rateExceeded) {
      return problem(c, 429, "about:blank", "Too many uploads");
    }

    const contentType =
      c.req.header("content-type")?.trim() || "application/octet-stream";

    const declared = Number(c.req.header("content-length"));
    // Without a length, buffer the body to learn it; uploads are bounded anyway.
    let body: ReadableStream<Uint8Array> | ArrayBuffer | null = c.req.raw.body;
    let size = declared;

    if (!Number.isSafeInteger(declared) || declared < 0) {
      body = await c.req.arrayBuffer();
      size = body.byteLength;
    }

    if (size > MAX_COMPOSER_ATTACHMENT_BYTES) {
      return problem(
        c,
        413,
        "urn:ietf:params:jmap:error:limit",
        "The upload is too large"
      );
    }

    try {
      const intent = await createComposerUploadIntent({
        env: c.env,
        mailboxId: account.id,
        userId: user.id,
        filename: "upload",
        contentType,
        size,
      });

      await storeComposerUploadContent({
        env: c.env,
        mailboxId: account.id,
        userId: user.id,
        uploadId: intent.id,
        body,
        contentType,
        contentLength: size,
      });

      const upload = await finalizeComposerUpload({
        env: c.env,
        mailboxId: account.id,
        userId: user.id,
        uploadId: intent.id,
        defer: (task) => c.executionCtx.waitUntil(task),
      });

      return c.json(
        {
          accountId: account.id,
          blobId: `upl~${upload.id}`,
          type: upload.contentType,
          size: upload.size,
        },
        201
      );
    } catch (error) {
      if (error instanceof UploadValidationError) {
        return problem(c, 400, "about:blank", error.message);
      }

      throw error;
    }
  })
  .get(`${JMAP_PATH}/eventsource`, async (c) => {
    const refused = missingScope(c, MAIL_READ_SCOPE);

    if (refused) return refused;
    const user = c.get("jmapUser");

    return jmapEventStream({
      env: c.env,
      accounts: await jmapAccounts(c.env, user.id),
      types: c.req.query("types") ?? "*",
      closeAfterState: c.req.query("closeafter") === "state",
      pingSeconds: Number(c.req.query("ping") ?? 0),
      // The stream outlives the request check; the token is checked again on each ping.
      stillAuthorized: async () =>
        Boolean(
          (await jmapIdentity(c, user.token))?.scopes.includes(MAIL_READ_SCOPE)
        ),
      currentAccounts: () => jmapAccounts(c.env, user.id),
      defer: (task) => c.executionCtx.waitUntil(task),
    });
  });
