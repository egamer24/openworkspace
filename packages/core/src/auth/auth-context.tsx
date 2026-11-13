import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect } from "react";
import type { ReactNode } from "react";

import type { AccessLinkKind } from "../../shared/auth";
import { invariant } from "../../shared/invariant";
import { api, AUTH_UNAUTHORIZED_EVENT, responseJson } from "../lib/api";
import type { SuccessfulResponse } from "../lib/api";
import {
  beforeSignOut,
  clientModules,
  prefetchModules,
  seedModules,
} from "../modules";
import type { ClientModule } from "../modules";

type Bootstrap = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.bootstrap.$get>>
>;

type ServerCreationOptions = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.auth.bootstrap.options.$post>>
>["options"];

type ServerRequestOptions = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.auth.login.options.$post>>
>["options"];

/*
 * The passkey ceremonies, with the browser package loaded on first use.
 *
 * The options are as the server sent them. Hono types a JSON body from
 * @simplewebauthn/server's option types, whose `extensions` hold binary PRF
 * inputs that can't cross JSON; the server never sets them, and without them
 * the body is exactly the browser package's JSON options.
 */
async function registerPasskey(options: ServerCreationOptions) {
  const { startRegistration } = await import("@simplewebauthn/browser");
  const { extensions, ...optionsJSON } = options;
  invariant(extensions === undefined, "The server sent passkey extensions");

  return startRegistration({ optionsJSON });
}

async function authenticateWithPasskey(options: ServerRequestOptions) {
  const { startAuthentication } = await import("@simplewebauthn/browser");
  const { extensions, ...optionsJSON } = options;
  invariant(extensions === undefined, "The server sent passkey extensions");

  return startAuthentication({ optionsJSON });
}

type AuthState = Omit<Bootstrap, "ok" | "modules">;

type ReauthenticationRequest =
  | { kind: "oidc"; requestId: string }
  | { kind: "saml"; requestId: string };

type AuthContextValue = AuthState & {
  loading: boolean;
  error: Error | null;
  retry: () => Promise<void>;
  bootstrap: (
    input: { name: string; email: string },
    mock?: boolean
  ) => Promise<void>;
  login: (mock?: boolean) => Promise<void>;
  reauthenticate: (
    request: ReauthenticationRequest,
    mock?: boolean
  ) => Promise<string>;
  logout: () => Promise<void>;
  completeAccessLink: (kind: AccessLinkKind, token: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const AFTER_SIGN_IN_RETRY_DELAYS_MS = [0, 1000, 5000] as const;

function clearAccountQueries(queryClient: QueryClient) {
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== "auth-state",
  });
}

/** The account a bootstrap response is for: `null` when no one is signed in. */
function bootstrapAccountId(data: Bootstrap) {
  return data.authenticated ? (data.user?.id ?? null) : null;
}

/**
 * Gets the query cache ready for the account `next` is for, before the app
 * sees it: drops the previous account's queries when it changed (not on the
 * first check) and seeds the startup data the modules loaded for the URL, so
 * no screen fetches what the seed has.
 */
function prepareAccountQueries(
  queryClient: QueryClient,
  previous: Bootstrap | undefined,
  next: Bootstrap
) {
  const accountId = bootstrapAccountId(next);

  if (previous && bootstrapAccountId(previous) === accountId) return;

  if (previous) clearAccountQueries(queryClient);

  if (accountId && next.modules) seedModules(queryClient, next.modules);
}

type AfterSignInAttempt = "done" | "inactive" | { error: unknown };

async function attemptAfterSignIn(
  module: ClientModule,
  delayMs: number,
  isActive: () => boolean
): Promise<AfterSignInAttempt> {
  if (delayMs) {
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  if (!isActive()) return "inactive";

  try {
    await module.afterSignIn?.();

    return "done";
  } catch (error) {
    return { error };
  }
}

async function runAfterSignIn(module: ClientModule, isActive: () => boolean) {
  let lastError: unknown;

  for (const delayMs of AFTER_SIGN_IN_RETRY_DELAYS_MS) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- retries: each attempt starts only after the previous one failed
    const attempt = await attemptAfterSignIn(module, delayMs, isActive);

    if (attempt === "done" || attempt === "inactive") return;
    lastError = attempt.error;
  }

  if (isActive()) {
    console.error(
      `The ${module.name} module could not finish signing in`,
      lastError
    );
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const state = useQuery({
    queryKey: ["auth-state"],
    // The app's first request. When no one was signed in yet (the first
    // check, or after signing in), it also carries what the modules show
    // first at this URL; later checks only re-read the session. The cache is
    // ready for the account before the response reaches the app.
    queryFn: async () => {
      const previous = queryClient.getQueryData<Bootstrap>(["auth-state"]);

      const query = previous?.authenticated
        ? {}
        : { path: window.location.pathname, search: window.location.search };

      const next = await responseJson(await api.api.bootstrap.$get({ query }));
      prepareAccountQueries(queryClient, previous, next);

      return next;
    },
  });

  const resolvedAccountId = state.isSuccess
    ? bootstrapAccountId(state.data)
    : undefined;

  // Once the account is known (and its old queries are cleared), modules
  // start the requests for the screen in the URL while its code loads.
  useEffect(() => {
    if (!resolvedAccountId) return;
    prefetchModules(queryClient, window.location);
  }, [queryClient, resolvedAccountId]);

  useEffect(() => {
    const refreshAuthentication = () => {
      void queryClient.invalidateQueries({ queryKey: ["auth-state"] });
    };

    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, refreshAuthentication);

    return () => {
      window.removeEventListener(
        AUTH_UNAUTHORIZED_EVENT,
        refreshAuthentication
      );
    };
  }, [queryClient]);

  useEffect(() => {
    if (!resolvedAccountId) return;
    let active = true;
    let syncing = false;

    const sync = () => {
      if (syncing) return;
      syncing = true;
      void Promise.all(
        clientModules()
          .filter((module) => module.afterSignIn)
          .map((module) => runAfterSignIn(module, () => active))
      ).finally(() => {
        syncing = false;
      });
    };

    sync();
    window.addEventListener("online", sync);

    return () => {
      active = false;
      window.removeEventListener("online", sync);
    };
  }, [resolvedAccountId]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["auth-state"] });
  }, [queryClient]);

  const bootstrap = useCallback(
    async (input: { name: string; email: string }, mock = false) => {
      if (mock) {
        await responseJson(
          await api.api.auth.mock.bootstrap.$post({ json: input })
        );
      } else {
        const options = await responseJson(
          await api.api.auth.bootstrap.options.$post({ json: input })
        );

        const response = await registerPasskey(options.options);

        await responseJson(
          await api.api.auth.bootstrap.verify.$post({
            json: { challengeId: options.challengeId, response },
          })
        );
      }

      await refresh();
    },
    [refresh]
  );

  const login = useCallback(
    async (mock = false) => {
      if (mock) {
        await responseJson(
          await api.api.auth.mock.login.$post({
            json: { userId: "usr_demo_admin" },
          })
        );
      } else {
        const options = await responseJson(
          await api.api.auth.login.options.$post({ query: {} })
        );

        const response = await authenticateWithPasskey(options.options);

        await responseJson(
          await api.api.auth.login.verify.$post({
            json: { challengeId: options.challengeId, response },
          })
        );
      }

      await refresh();
    },
    [refresh]
  );

  const reauthenticate = useCallback(
    async (request: ReauthenticationRequest, mock = false) => {
      let result: { redirectTo: string | null };

      if (mock) {
        result = await responseJson(
          await api.api.auth.mock.login.$post({
            json:
              request.kind === "oidc"
                ? { userId: "usr_demo_admin", oidcRequestId: request.requestId }
                : {
                    userId: "usr_demo_admin",
                    samlRequestId: request.requestId,
                  },
          })
        );
      } else {
        const options = await responseJson(
          await api.api.auth.login.options.$post({
            query:
              request.kind === "oidc"
                ? { oidcRequestId: request.requestId }
                : { samlRequestId: request.requestId },
          })
        );

        const response = await authenticateWithPasskey(options.options);

        result = await responseJson(
          await api.api.auth.login.verify.$post({
            json: { challengeId: options.challengeId, response },
          })
        );
      }

      if (!result.redirectTo) {
        throw new Error(
          `${request.kind.toUpperCase()} re-authentication did not return a continuation`
        );
      }

      return result.redirectTo;
    },
    []
  );

  const logout = useCallback(async () => {
    await beforeSignOut();
    await responseJson(await api.api.auth.logout.$post());
    clearAccountQueries(queryClient);
    await refresh();
  }, [queryClient, refresh]);

  const completeAccessLink = useCallback(
    async (kind: AccessLinkKind, token: string) => {
      const options = await responseJson(
        kind === "invitation"
          ? await api.api.auth.invitation[":token"].options.$post({
              param: { token },
            })
          : await api.api.auth.recovery[":token"].options.$post({
              param: { token },
            })
      );

      const response = await registerPasskey(options.options);

      await responseJson(
        kind === "invitation"
          ? await api.api.auth.invitation[":token"].verify.$post({
              param: { token },
              json: { challengeId: options.challengeId, response },
            })
          : await api.api.auth.recovery[":token"].verify.$post({
              param: { token },
              json: { challengeId: options.challengeId, response },
            })
      );
      await refresh();
    },
    [refresh]
  );

  const value: AuthContextValue = {
    needsBootstrap: state.data?.needsBootstrap ?? false,
    setupMailDomains: state.data?.setupMailDomains ?? [],
    authenticated: state.data?.authenticated ?? false,
    sessionVersion: state.data?.sessionVersion ?? null,
    user: state.data?.user ?? null,
    mockAuthEnabled: state.data?.mockAuthEnabled ?? false,
    workspaceLogoUrl: state.data?.workspaceLogoUrl ?? null,
    workspaceName: state.data?.workspaceName ?? null,
    // A failed initial check is unknown authentication, not a signed-out session.
    // Keep cached identity on background errors; only a successful response can revoke it.
    loading: state.isPending,
    error: state.data ? null : state.error,
    retry: refresh,
    bootstrap,
    login,
    reauthenticate,
    logout,
    completeAccessLink,
  };

  // oxlint-disable-next-line react/jsx-no-constructed-context-values -- its callbacks aren't memoized; consumers re-render with the provider
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);

  if (!value) throw new Error("useAuth must be used inside AuthProvider");

  return value;
}
