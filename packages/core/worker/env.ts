import type { User } from "./db/schema";
import type { ServerTimingEntry } from "./lib/server-timing";

export type SessionUser = Pick<
  User,
  "id" | "name" | "avatarId" | "role" | "status" | "permissions"
>;

export type AppEnv = {
  /** The Worker's bindings, as `OpenWorkspace` and the modules declare them (bindings.d.ts). */
  Bindings: Env;
  Variables: {
    user: SessionUser;
    authKind: "session" | "oauth";
    /**
     * For an OAuth token: the scopes it was granted that the person may
     * still use (oidc/scopes.ts). Unset for browser sessions.
     */
    oauthScopes: readonly string[];
    sessionId: string;
    sessionTokenHash: string;
    /** Set for /api requests; see lib/server-timing.ts. */
    serverTiming: ServerTimingEntry[] | undefined;
    /**
     * What `requireAuthWith`'s companion statement returned, read in the
     * same D1 round trip as the session. Unset for other authentication.
     */
    authCompanion: unknown;
  };
};
