import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

/**
 * Signing in to a workspace the way an MCP client does: self-registration
 * (RFC 7591) with a loopback redirect, the authorization code flow with
 * PKCE, a token for the workspace's /mcp resource (which its /api accepts),
 * and refresh tokens. Tokens are kept in ~/.config/open-workspace so a
 * long or resumed import does not sign in again.
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const metadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
});

type Metadata = z.infer<typeof metadataSchema>;

const storedTokenSchema = z.object({
  clientId: z.string(),
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number(),
  scope: z.string(),
});

type StoredToken = z.infer<typeof storedTokenSchema>;

const storeSchema = z.record(z.string(), storedTokenSchema);

/** An OAuth error response (RFC 6749 section 5.2); every field is optional so any body parses. */
const oauthErrorSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

/** A successful token response (RFC 6749 section 5.1). */
const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.coerce.number().optional(),
  scope: z.string().optional(),
});

type TokenResponse = z.infer<typeof tokenResponseSchema>;

const registrationSchema = z.object({ client_id: z.string().min(1) });

/** Why the authorization server refused: its error description, its error code, or the HTTP status. */
async function refusal(response: Response) {
  // A refusal need not have a JSON body; then only the status explains it.
  const body = oauthErrorSchema.safeParse(
    await response.json().catch(() => null)
  );

  const error = body.success ? body.data : {};

  return error.error_description ?? error.error ?? response.status;
}

/** A token response, or an error that says why the server refused (`what` names the step). */
async function tokenResponse(response: Response, what: string) {
  if (!response.ok) {
    throw new Error(`${what}: ${await refusal(response)}`);
  }

  const body = tokenResponseSchema.safeParse(await response.json());

  if (!body.success) {
    throw new Error(`${what}: the token response is malformed`);
  }

  return body.data;
}

export type TokenSource = {
  /** A current access token. */
  token(): Promise<string>;
  /** A new access token after the workspace refused the last one. */
  refresh(): Promise<string>;
  /** The scopes the workspace granted. */
  readonly scopes: string[];
};

/** An access token given on the command line; it cannot be refreshed. */
export class StaticToken implements TokenSource {
  constructor(
    private readonly value: string,
    readonly scopes: string[] = []
  ) {}
  token() {
    return Promise.resolve(this.value);
  }
  refresh(): Promise<string> {
    return Promise.reject(
      new Error(
        "The access token was refused; pass a new --token or sign in without one"
      )
    );
  }
}

function base64Url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

async function pkce() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));

  const challenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  );

  return { verifier, challenge };
}

export function defaultCredentialsPath() {
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "open-workspace",
    "credentials.json"
  );
}

/** The stored tokens; a missing, unreadable or malformed file is an empty store (tokens are only a cache). */
function readStore(path: string): Record<string, StoredToken> {
  try {
    const store = storeSchema.safeParse(
      JSON.parse(readFileSync(path, "utf-8"))
    );

    return store.success ? store.data : {};
  } catch {
    return {};
  }
}

function writeStore(path: string, store: Record<string, StoredToken>) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Opens a URL in the default browser, best effort. */
export function openInBrowser(url: string) {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // The URL is printed too.
  }
}

export type LoginOptions = {
  /** The workspace's origin, e.g. https://mail.acme.com. */
  workspace: string;
  scopes: string[];
  fetch?: Fetch;
  /** Shows the sign-in page; defaults to printing the URL and opening the browser. */
  openBrowser?: (url: string) => void | Promise<void>;
  /** Where tokens are kept; null keeps them in memory only. */
  credentialsPath?: string | null;
  /** Sign in again even with a stored token. */
  fresh?: boolean;
  log?: (message: string) => void;
};

export class OAuthSession implements TokenSource {
  private constructor(
    private stored: StoredToken,
    private readonly metadata: Metadata,
    private readonly resource: string,
    private readonly fetchImpl: Fetch,
    private readonly save: (token: StoredToken) => void
  ) {}

  get scopes() {
    return this.stored.scope.split(/\s+/u).filter(Boolean);
  }

  token() {
    if (Date.now() < this.stored.expiresAt - 30_000) {
      return Promise.resolve(this.stored.accessToken);
    }

    return this.refresh();
  }

  async refresh() {
    if (!this.stored.refreshToken) {
      throw new Error("The sign-in expired; run the command again to sign in");
    }

    const response = await this.fetchImpl(this.metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.stored.refreshToken,
        client_id: this.stored.clientId,
        resource: this.resource,
      }),
    });

    const body = await tokenResponse(response, "Could not refresh the sign-in");
    this.stored = tokenFrom(this.stored.clientId, body, this.stored);
    this.save(this.stored);

    return this.stored.accessToken;
  }

  /** A signed-in session: a stored one that still refreshes, else a browser sign-in. */
  static async login(options: LoginOptions): Promise<OAuthSession> {
    const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    const log = options.log ?? ((message) => console.error(message));
    const { origin } = new URL(options.workspace);

    const metadataResponse = await fetchImpl(
      `${origin}/.well-known/oauth-authorization-server`
    );

    if (!metadataResponse.ok) {
      throw new Error(
        `${origin} does not look like an OpenWorkspace (no OAuth metadata)`
      );
    }

    const parsedMetadata = metadataSchema.safeParse(
      await metadataResponse.json()
    );

    if (!parsedMetadata.success) {
      throw new Error(`${origin} published malformed OAuth metadata`);
    }

    const metadata = parsedMetadata.data;
    const resource = `${origin}/mcp`;
    const key = `${origin} ${[...options.scopes].sort().join(" ")}`;

    const path =
      options.credentialsPath === undefined
        ? defaultCredentialsPath()
        : options.credentialsPath;

    const save = (token: StoredToken) => {
      if (path) writeStore(path, { ...readStore(path), [key]: token });
    };

    const stored = path && !options.fresh ? readStore(path)[key] : undefined;

    if (stored) {
      const session = new OAuthSession(
        stored,
        metadata,
        resource,
        fetchImpl,
        save
      );

      try {
        await session.token();

        return session;
      } catch {
        // Fall through to a new sign-in.
      }
    }

    if (!metadata.registration_endpoint) {
      throw new Error(`${origin} does not let apps register themselves`);
    }

    const { verifier, challenge } = await pkce();
    const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
    let resolveCode!: (value: URLSearchParams) => void;

    const callback = new Promise<URLSearchParams>((resolve) => {
      resolveCode = resolve;
    });

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);

        if (url.pathname !== "/callback") {
          return new Response("Not found", { status: 404 });
        }

        resolveCode(url.searchParams);
        const failed = url.searchParams.has("error");

        return new Response(
          failed
            ? "Sign-in was not completed. You can close this tab."
            : "Signed in. You can close this tab and return to the terminal.",
          { headers: { "content-type": "text/plain; charset=utf-8" } }
        );
      },
    });

    try {
      const redirectUri = `http://127.0.0.1:${server.port}/callback`;

      const registration = await fetchImpl(metadata.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "OpenWorkspace import",
          redirect_uris: [redirectUri],
          scope: options.scopes.join(" "),
        }),
      });

      if (!registration.ok) {
        throw new Error(
          `Could not register the importer: ${await refusal(registration)}`
        );
      }

      const registered = registrationSchema.safeParse(
        await registration.json()
      );

      if (!registered.success) {
        throw new Error(
          `Could not register the importer: ${registration.status} without a client_id`
        );
      }

      const client = registered.data;

      const authorize = new URL(metadata.authorization_endpoint);

      for (const [name, value] of Object.entries({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: options.scopes.join(" "),
        resource,
        state,
      })) {
        authorize.searchParams.set(name, value);
      }

      log(`Sign in to ${origin} in your browser:\n  ${authorize}`);
      await (options.openBrowser ?? openInBrowser)(authorize.toString());

      const params = await callback;

      if (params.get("error")) {
        throw new Error(
          `Sign-in failed: ${params.get("error_description") ?? params.get("error")}`
        );
      }

      if (params.get("state") !== state) {
        throw new Error(
          "Sign-in failed: the response does not match this request"
        );
      }

      if (params.get("iss") && params.get("iss") !== metadata.issuer) {
        throw new Error(
          "Sign-in failed: the response came from another issuer"
        );
      }

      const exchanged = await fetchImpl(metadata.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: params.get("code") ?? "",
          redirect_uri: redirectUri,
          code_verifier: verifier,
          client_id: client.client_id,
          resource,
        }),
      });

      const body = await tokenResponse(exchanged, "Sign-in failed");
      const token = tokenFrom(client.client_id, body);
      save(token);

      return new OAuthSession(token, metadata, resource, fetchImpl, save);
    } finally {
      server.stop(true);
    }
  }
}

function tokenFrom(
  clientId: string,
  body: TokenResponse,
  previous?: StoredToken
): StoredToken {
  return {
    clientId,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + (body.expires_in ?? 600) * 1000,
    scope: body.scope ?? previous?.scope ?? "",
  };
}
