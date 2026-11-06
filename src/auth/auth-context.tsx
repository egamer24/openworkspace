import type { AccessLinkKind } from "../../shared/auth";
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  AUTH_UNAUTHORIZED_EVENT,
  responseJson,
  type SuccessfulResponse,
} from "@/lib/api";

type AuthState = Omit<
  SuccessfulResponse<Awaited<ReturnType<typeof api.api.auth.state.$get>>>,
  "ok"
>;

type ReauthenticationRequest =
  | { kind: "oidc"; requestId: string }
  | { kind: "saml"; requestId: string };

type AuthContextValue = AuthState & {
  loading: boolean;
  error: Error | null;
  retry: () => Promise<void>;
  bootstrap: (input: { name: string; email: string }, mock?: boolean) => Promise<void>;
  login: (mock?: boolean) => Promise<void>;
  reauthenticate: (
    request: ReauthenticationRequest,
    mock?: boolean,
  ) => Promise<string>;
  logout: () => Promise<void>;
  completeAccessLink: (
    kind: AccessLinkKind,
    token: string,
  ) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const PUSH_SYNC_RETRY_DELAYS_MS = [0, 1_000, 5_000] as const;

function clearAccountQueries(queryClient: QueryClient) {
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== "auth-state",
  });
}

async function syncAccountPushSubscription(isActive: () => boolean) {
  let lastError: unknown;
  for (const delayMs of PUSH_SYNC_RETRY_DELAYS_MS) {
    if (delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!isActive()) return;
    try {
      const { syncCurrentPushSubscription } = await import(
        "@/pwa/push-subscription"
      );
      await syncCurrentPushSubscription();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  if (isActive()) {
    console.error("Could not sync browser push subscription", lastError);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [queryAccountId, setQueryAccountId] = useState<
    string | null | undefined
  >(undefined);
  const state = useQuery({
    queryKey: ["auth-state"],
    queryFn: async () => responseJson(await api.api.auth.state.$get()),
  });
  const resolvedAccountId = state.isSuccess
    ? state.data.authenticated
      ? state.data.user?.id ?? null
      : null
    : undefined;
  const accountChanging = resolvedAccountId !== undefined
    && queryAccountId !== undefined
    && resolvedAccountId !== queryAccountId;

  useLayoutEffect(() => {
    if (
      resolvedAccountId === undefined
      || resolvedAccountId === queryAccountId
    ) {
      return;
    }
    if (queryAccountId !== undefined) clearAccountQueries(queryClient);
    setQueryAccountId(resolvedAccountId);
  }, [queryAccountId, queryClient, resolvedAccountId]);

  useEffect(() => {
    const refreshAuthentication = () => {
      void queryClient.invalidateQueries({ queryKey: ["auth-state"] });
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, refreshAuthentication);
    return () => {
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, refreshAuthentication);
    };
  }, [queryClient]);

  useEffect(() => {
    if (!resolvedAccountId) return;
    let active = true;
    let syncing = false;
    const sync = () => {
      if (syncing) return;
      syncing = true;
      void syncAccountPushSubscription(() => active).finally(() => {
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
          await api.api.auth.mock.bootstrap.$post({ json: input }),
        );
      } else {
        const options = await responseJson(
          await api.api.auth.bootstrap.options.$post({ json: input }),
        );
        const { startRegistration } = await import("@simplewebauthn/browser");
        const response = await startRegistration({ optionsJSON: options.options });
        await responseJson(
          await api.api.auth.bootstrap.verify.$post({
            json: { challengeId: options.challengeId, response },
          }),
        );
      }
      await refresh();
    },
    [refresh],
  );

  const login = useCallback(
    async (mock = false) => {
      if (mock) {
        await responseJson(
          await api.api.auth.mock.login.$post({
            json: { userId: "usr_demo_admin" },
          }),
        );
      } else {
        const options = await responseJson(
          await api.api.auth.login.options.$post({ query: {} }),
        );
        const { startAuthentication } = await import("@simplewebauthn/browser");
        const response = await startAuthentication({ optionsJSON: options.options });
        await responseJson(
          await api.api.auth.login.verify.$post({
            json: { challengeId: options.challengeId, response },
          }),
        );
      }
      await refresh();
    },
    [refresh],
  );

  const reauthenticate = useCallback(
    async (request: ReauthenticationRequest, mock = false) => {
      let result: { redirectTo: string | null };
      if (mock) {
        result = await responseJson(
          await api.api.auth.mock.login.$post({
            json: request.kind === "oidc"
              ? { userId: "usr_demo_admin", oidcRequestId: request.requestId }
              : { userId: "usr_demo_admin", samlRequestId: request.requestId },
          }),
        );
      } else {
        const options = await responseJson(
          await api.api.auth.login.options.$post({
            query: request.kind === "oidc"
              ? { oidcRequestId: request.requestId }
              : { samlRequestId: request.requestId },
          }),
        );
        const { startAuthentication } = await import("@simplewebauthn/browser");
        const response = await startAuthentication({ optionsJSON: options.options });
        result = await responseJson(
          await api.api.auth.login.verify.$post({
            json: { challengeId: options.challengeId, response },
          }),
        );
      }
      if (!result.redirectTo) {
        throw new Error(`${request.kind.toUpperCase()} re-authentication did not return a continuation`);
      }
      return result.redirectTo;
    },
    [],
  );

  const logout = useCallback(async () => {
    const { pushSubscriptionEndpointForLogout } = await import(
      "@/pwa/push-subscription"
    );
    const pushEndpoint = await pushSubscriptionEndpointForLogout();
    await responseJson(
      await api.api.auth.logout.$post({
        json: { pushEndpoint: pushEndpoint ?? undefined },
      }),
    );
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
            }),
      );
      const { startRegistration } = await import("@simplewebauthn/browser");
      const response = await startRegistration({ optionsJSON: options.options });
      await responseJson(
        kind === "invitation"
          ? await api.api.auth.invitation[":token"].verify.$post({
              param: { token },
              json: { challengeId: options.challengeId, response },
            })
          : await api.api.auth.recovery[":token"].verify.$post({
              param: { token },
              json: { challengeId: options.challengeId, response },
            }),
      );
      await refresh();
    },
    [refresh],
  );

  const value: AuthContextValue = {
    needsBootstrap: state.data?.needsBootstrap ?? false,
    authenticated: state.data?.authenticated ?? false,
    sessionVersion: state.data?.sessionVersion ?? null,
    user: state.data?.user ?? null,
    mockAuthEnabled: state.data?.mockAuthEnabled ?? false,
    modules: state.data?.modules ?? { calendar: false },
    // A failed initial check is unknown authentication, not a signed-out session.
    // Keep cached identity on background errors; only a successful response can revoke it.
    loading: state.isPending || accountChanging,
    error: state.data ? null : state.error,
    retry: refresh,
    bootstrap,
    login,
    reauthenticate,
    logout,
    completeAccessLink,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
