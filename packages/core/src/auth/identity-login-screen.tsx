import { useQuery } from "@tanstack/react-query";
import { KeyRound, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";

import { Button } from "../components/ui/button";
import { api, responseJson } from "../lib/api";
import { useAuth } from "./auth-context";
import {
  AuthAlert,
  AuthDemoOption,
  AuthHeading,
  AuthLoading,
  AuthShell,
  AuthUnavailable,
  authAction,
} from "./auth-shell";
import { passkeyErrorMessage } from "./passkey-error";

type IdentityProtocol = "oidc" | "saml";

const descriptions: Record<IdentityProtocol, string> = {
  oidc: "Confirm it's you with your passkey. Your current session here stays until the passkey checks out.",
  saml: "Confirm it's you with your passkey to continue.",
};

async function identityRequestName(kind: IdentityProtocol, requestId: string) {
  if (kind === "oidc") {
    const result = await responseJson(
      await api.api.oidc.login[":id"].$get({ param: { id: requestId } })
    );

    return result.transaction.clientName;
  }

  const result = await responseJson(
    await api.api.saml.login[":id"].$get({ param: { id: requestId } })
  );

  return result.transaction.applicationName;
}

export function IdentityLoginScreen({ kind }: { kind: IdentityProtocol }) {
  const auth = useAuth();
  const { requestId = "" } = useParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const transaction = useQuery({
    queryKey: [`${kind}-login`, requestId],
    queryFn: () => identityRequestName(kind, requestId),
    retry: false,
  });

  async function reauthenticate(mock = false) {
    setBusy(true);
    setError(null);

    try {
      const redirectTo = await auth.reauthenticate({ kind, requestId }, mock);
      window.location.assign(redirectTo);
    } catch (failure) {
      setError(passkeyErrorMessage(failure, "Could not confirm your identity"));
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      {transaction.isLoading ? (
        <AuthLoading />
      ) : transaction.isError || !transaction.data ? (
        <AuthUnavailable
          title="Sign-in request expired"
          description="This sign-in request expired or was opened in another browser. Go back to the app and sign in again."
          action="Go to OpenWorkspace"
        />
      ) : (
        <>
          <AuthHeading
            title={`Continue to ${transaction.data}`}
            description={descriptions[kind]}
          />
          <div className="mt-7 space-y-3.5">
            <Button
              className={authAction}
              size="lg"
              disabled={busy}
              onClick={() => void reauthenticate()}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
              Confirm with passkey
            </Button>
            {auth.mockAuthEnabled ? (
              <AuthDemoOption>
                <Button
                  className={authAction}
                  variant="outline"
                  size="lg"
                  disabled={busy}
                  onClick={() => void reauthenticate(true)}
                >
                  Open seeded local demo
                </Button>
              </AuthDemoOption>
            ) : null}
            {error ? <AuthAlert>{error}</AuthAlert> : null}
          </div>
        </>
      )}
    </AuthShell>
  );
}
