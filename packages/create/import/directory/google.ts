import { z } from "zod";

import { forEachConcurrent } from "../concurrency.ts";
import type { Fetch } from "../oauth.ts";
import type { Directory, DirectoryGroup, DirectoryUser } from "./plan.ts";

/**
 * Reading a Google Workspace directory with the Admin SDK Directory API,
 * with credentials the administrator brings (OpenWorkspace ships no Google
 * client): a service account with domain-wide delegation acting as an
 * administrator, or their own OAuth client ("Desktop app") signed in
 * through the browser.
 */

export const DIRECTORY_READ_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.member.readonly",
];

/** Optional: who may post to each group, and whether it is a collaborative inbox. */
export const GROUP_SETTINGS_SCOPE =
  "https://www.googleapis.com/auth/apps.groups.settings";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DIRECTORY = "https://admin.googleapis.com/admin/directory/v1";
const GROUP_SETTINGS = "https://www.googleapis.com/groups/v1/groups";

const serviceAccountKeySchema = z.object({
  type: z.literal("service_account"),
  client_email: z.string(),
  private_key: z.string(),
  token_uri: z.string().optional(),
});

type ServiceAccountKey = z.infer<typeof serviceAccountKeySchema>;

const installedClientSchema = z.object({
  installed: z.object({
    client_id: z.string().min(1),
    client_secret: z.string().optional(),
  }),
});

type InstalledClient = z.infer<typeof installedClientSchema>;

/** A Google OAuth error; every field is optional so any body parses. */
const googleErrorSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const accessTokenSchema = z.object({ access_token: z.string().min(1) });

/** Google's access token, or an error with why it refused (`explain` words it). */
async function accessToken(
  response: Response,
  explain: (reason: string | number) => string
) {
  const json = await response.json().catch(() => null);
  const token = accessTokenSchema.safeParse(json);

  if (response.ok && token.success) return token.data.access_token;
  const refusal = googleErrorSchema.safeParse(json);
  const error = refusal.success ? refusal.data : {};

  throw new Error(
    explain(error.error_description ?? error.error ?? response.status)
  );
}

const base64Url = (value: string | Uint8Array) =>
  Buffer.from(value).toString("base64url");

/** A service account's token, impersonating `subject` (domain-wide delegation). */
async function serviceAccountToken(
  key: ServiceAccountKey,
  subject: string,
  scopes: string[],
  fetchImpl: Fetch
) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));

  const claims = base64Url(
    JSON.stringify({
      iss: key.client_email,
      sub: subject,
      scope: scopes.join(" "),
      aud: key.token_uri ?? TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );

  const der = Buffer.from(
    key.private_key.replaceAll(/-----[^-]+-----|\s/gu, ""),
    "base64"
  );

  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      signingKey,
      new TextEncoder().encode(`${header}.${claims}`)
    )
  );

  const response = await fetchImpl(key.token_uri ?? TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${base64Url(signature)}`,
    }),
  });

  return accessToken(
    response,
    (reason) =>
      `Google refused the service account (${reason}). Check its domain-wide delegation scopes and that --admin is a super administrator.`
  );
}

/** The administrator signs in with their own Desktop OAuth client, in the browser (loopback, PKCE). */
async function installedClientToken(
  client: InstalledClient["installed"],
  scopes: string[],
  fetchImpl: Fetch,
  openBrowser: (url: string) => void | Promise<void>,
  log: (message: string) => void
) {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));

  const challenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  );

  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  let receive!: (params: URLSearchParams) => void;

  const callback = new Promise<URLSearchParams>((resolve) => {
    receive = resolve;
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname !== "/") {
        return new Response("Not found", { status: 404 });
      }

      receive(url.searchParams);

      return new Response("Signed in to Google. You can close this tab.", {
        headers: { "content-type": "text/plain" },
      });
    },
  });

  try {
    const redirectUri = `http://127.0.0.1:${server.port}/`;
    const url = new URL(AUTH_URL);

    for (const [name, value] of Object.entries({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    })) {
      url.searchParams.set(name, value);
    }

    log(`Sign in to Google as an administrator:\n  ${url}`);
    await openBrowser(url.toString());
    const params = await callback;

    const code = params.get("code");

    if (params.get("state") !== state || !code) {
      throw new Error(
        `Google sign-in failed: ${params.get("error") ?? "no code"}`
      );
    }

    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: client.client_id,
    });

    if (client.client_secret) form.set("client_secret", client.client_secret);
    form.set("code_verifier", verifier);

    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });

    return accessToken(
      response,
      (reason) => `Google sign-in failed: ${reason}`
    );
  } finally {
    server.stop(true);
  }
}

export type GoogleCredentialsOptions = {
  /** The JSON Google Cloud gave you (parsed): a service account key, or a Desktop OAuth client. */
  credentials: z.core.util.JSONType;
  /** For a service account: the super administrator it acts as. */
  admin?: string;
  groupSettings: boolean;
  fetch: Fetch;
  openBrowser: (url: string) => void | Promise<void>;
  log: (message: string) => void;
};

export function googleAccessToken(
  options: GoogleCredentialsOptions
): Promise<string> {
  const scopes = [
    ...DIRECTORY_READ_SCOPES,
    ...(options.groupSettings ? [GROUP_SETTINGS_SCOPE] : []),
  ];

  const serviceAccount = serviceAccountKeySchema.safeParse(options.credentials);

  if (serviceAccount.success) {
    if (!options.admin) {
      return Promise.reject(
        new Error(
          "A service account acts as an administrator: pass --admin admin@your-domain"
        )
      );
    }

    return serviceAccountToken(
      serviceAccount.data,
      options.admin,
      scopes,
      options.fetch
    );
  }

  const installed = installedClientSchema.safeParse(options.credentials);

  if (installed.success) {
    return installedClientToken(
      installed.data.installed,
      scopes,
      options.fetch,
      options.openBrowser,
      options.log
    );
  }

  return Promise.reject(
    new Error(
      "The Google credentials are neither a service account key nor a Desktop app OAuth client (see https://openworkspace.dev/docs/migration)"
    )
  );
}

/** Every page of a Directory API list: `schema` reads one page, `itemsOf` its items. */
async function pages<Schema extends z.ZodType, Item>(
  token: string,
  url: URL,
  schema: Schema,
  itemsOf: (page: z.output<Schema>) => Item[] | undefined,
  fetchImpl: Fetch,
  pageToken?: string
): Promise<Item[]> {
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const response = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${token}` },
  });

  const json = await response.json();

  if (!response.ok) {
    const refusal = directoryErrorSchema.safeParse(json);
    const message = refusal.success ? refusal.data.error?.message : undefined;

    throw new Error(
      `Google Directory API: ${message ?? response.status} (${url.pathname})`
    );
  }

  const page = schema.safeParse(json);
  const next = nextPageSchema.safeParse(json);

  if (!page.success) throw unexpectedAnswer(url, page.error);

  if (!next.success) throw unexpectedAnswer(url, next.error);

  const items = itemsOf(page.data) ?? [];
  const { nextPageToken } = next.data;

  if (!nextPageToken) return items;

  // Each page names the next one, so they are read one after another.
  return [
    ...items,
    ...(await pages(token, url, schema, itemsOf, fetchImpl, nextPageToken)),
  ];
}

function unexpectedAnswer(url: URL, error: z.ZodError) {
  return new Error(
    `Google Directory API: unexpected answer (${url.pathname}): ${z.prettifyError(error)}`
  );
}

const directoryErrorSchema = z.object({
  error: z.object({ message: z.string().optional() }).optional(),
});

const nextPageSchema = z.object({ nextPageToken: z.string().optional() });

const googleUserSchema = z.object({
  primaryEmail: z.string(),
  name: z.object({ fullName: z.string().optional() }).optional(),
  aliases: z.array(z.string()).optional(),
  suspended: z.boolean().optional(),
  archived: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
});

const usersPageSchema = z.object({
  users: z.array(googleUserSchema).optional(),
});

const googleGroupSchema = z.object({
  email: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  aliases: z.array(z.string()).optional(),
});

const groupsPageSchema = z.object({
  groups: z.array(googleGroupSchema).optional(),
});

const googleMemberSchema = z.object({
  email: z.string().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
});

const membersPageSchema = z.object({
  members: z.array(googleMemberSchema).optional(),
});

/** The Groups Settings API's answer, the parts read here (its booleans are strings). */
const groupSettingsSchema = z.object({
  whoCanPostMessage: z.string().optional(),
  enableCollaborativeInbox: z.string().optional(),
});

type GroupSettings = z.infer<typeof groupSettingsSchema>;

/** Directory API requests in flight while reading groups; well under Google's per-user quota. */
const GROUP_CONCURRENCY = 4;

/** What a group's whoCanPostMessage becomes. */
export function postingPolicy(
  whoCanPostMessage: string | undefined
): DirectoryGroup["posting"] {
  switch (whoCanPostMessage) {
    case "ANYONE_CAN_POST": {
      return "anyone";
    }

    case "ALL_IN_DOMAIN_CAN_POST": {
      return "workspace";
    }

    case "ALL_MEMBERS_CAN_POST":
    case "ALL_MANAGERS_CAN_POST":
    case "ALL_OWNERS_CAN_POST":
    case "NONE_CAN_POST": {
      return "members";
    }

    default: {
      return null;
    }
  }
}

/** Users, aliases, groups and members of the customer `customer` ("my_customer": the signed-in organization). */
export async function readGoogleDirectory(
  token: string,
  options: { customer?: string; groupSettings: boolean; fetch: Fetch }
): Promise<Directory> {
  const customer = options.customer ?? "my_customer";
  const usersUrl = new URL(`${DIRECTORY}/users`);
  usersUrl.searchParams.set("customer", customer);
  usersUrl.searchParams.set("maxResults", "500");
  usersUrl.searchParams.set("projection", "basic");

  const users = (
    await pages(
      token,
      usersUrl,
      usersPageSchema,
      (page) => page.users,
      options.fetch
    )
  ).map((user): DirectoryUser => ({
    email: user.primaryEmail,
    name: user.name?.fullName ?? user.primaryEmail,
    aliases: user.aliases ?? [],
    suspended: Boolean(user.suspended || user.archived),
    isAdmin: Boolean(user.isAdmin),
  }));

  const groupsUrl = new URL(`${DIRECTORY}/groups`);
  groupsUrl.searchParams.set("customer", customer);
  groupsUrl.searchParams.set("maxResults", "200");

  const googleGroups = await pages(
    token,
    groupsUrl,
    groupsPageSchema,
    (page) => page.groups,
    options.fetch
  );

  const groupSettings = async (email: string): Promise<GroupSettings> => {
    if (!options.groupSettings) return {};

    const response = await options.fetch(
      `${GROUP_SETTINGS}/${encodeURIComponent(email)}?alt=json`,
      {
        headers: { authorization: `Bearer ${token}` },
      }
    );

    if (!response.ok) return {};
    const settings = groupSettingsSchema.safeParse(await response.json());

    return settings.success ? settings.data : {};
  };

  // Groups are independent of each other: read a few at a time, kept in Google's order.
  const groups: DirectoryGroup[] = [];

  await forEachConcurrent(
    googleGroups,
    GROUP_CONCURRENCY,
    async (group, index) => {
      const membersUrl = new URL(
        `${DIRECTORY}/groups/${encodeURIComponent(group.email)}/members`
      );

      membersUrl.searchParams.set("maxResults", "200");

      const [members, settings] = await Promise.all([
        pages(
          token,
          membersUrl,
          membersPageSchema,
          (page) => page.members,
          options.fetch
        ),
        groupSettings(group.email),
      ]);

      groups[index] = {
        email: group.email,
        name: group.name ?? group.email,
        description: group.description ?? null,
        aliases: group.aliases ?? [],
        members: members.flatMap((member) => {
          if (member.status === "SUSPENDED") return [];
          const address = member.type === "CUSTOMER" ? "*" : member.email;

          return address ? [address] : [];
        }),
        sharedInbox: settings.enableCollaborativeInbox === "true",
        posting: postingPolicy(settings.whoCanPostMessage),
      };
    }
  );

  return { users, groups };
}
