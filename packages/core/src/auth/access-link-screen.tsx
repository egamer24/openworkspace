import { useQuery } from "@tanstack/react-query";
import { KeyRound, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";

import type { AccessLinkKind } from "../../shared/auth";
import { Button } from "../components/ui/button";
import { api, responseJson } from "../lib/api";
import { cn } from "../lib/utils";
import { useAuth } from "./auth-context";
import {
  AuthAlert,
  AuthHeading,
  AuthLoading,
  AuthShell,
  AuthUnavailable,
  authAction,
} from "./auth-shell";
import { passkeyErrorMessage } from "./passkey-error";

type AccessLinkCopy = {
  title: (name: string) => string;
  description: string;
  button: string;
  unavailable: string;
  unavailableDescription: string;
  error: string;
};

const copy = {
  invitation: {
    title: (name: string) => `Welcome, ${name}`,
    description:
      "You've been invited to this workspace. Save a passkey to finish setting up your account; you'll use it every time you sign in.",
    button: "Register passkey",
    unavailable: "Invitation unavailable",
    unavailableDescription:
      "This invitation is invalid, expired, or already used. Ask the person who invited you for a new link.",
    error: "Could not accept the invitation",
  },
  recovery: {
    title: (name: string) => `Recover access, ${name}`,
    description:
      "Save a new passkey for your account. It replaces your old passkeys and signs out your other sessions.",
    button: "Register replacement passkey",
    unavailable: "Recovery link unavailable",
    unavailableDescription:
      "This recovery link is invalid, expired, or already used. Ask an administrator for a new one.",
    error: "Could not recover the account",
  },
} satisfies Record<AccessLinkKind, AccessLinkCopy>;

export function AccessLinkScreen({ kind }: { kind: AccessLinkKind }) {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ["access-link", kind, token],
    queryFn: async () => {
      const result = await responseJson(
        kind === "invitation"
          ? await api.api.auth.invitation[":token"].$get({ param: { token } })
          : await api.api.auth.recovery[":token"].$get({ param: { token } })
      );

      return result.accessLink;
    },
    enabled: Boolean(token),
    retry: false,
  });

  const labels = copy[kind];

  async function complete() {
    setBusy(true);
    setError(null);

    try {
      await auth.completeAccessLink(kind, token);
      navigate("/", { replace: true });
    } catch (failure) {
      setError(passkeyErrorMessage(failure, labels.error));
    }

    setBusy(false);
  }

  return (
    <AuthShell>
      {preview.isLoading ? (
        <AuthLoading />
      ) : preview.isError || !preview.data ? (
        <AuthUnavailable
          title={labels.unavailable}
          description={labels.unavailableDescription}
        />
      ) : (
        <>
          <AuthHeading
            title={labels.title(preview.data.name)}
            description={labels.description}
          />
          <dl className="bg-surface ring-border mt-6 rounded-lg px-4 py-3 text-center ring-1">
            <dt className="text-muted-foreground text-xs">
              Your email address
            </dt>
            <dd className="mt-0.5 truncate text-sm font-medium">
              {preview.data.email}
            </dd>
          </dl>
          <Button
            className={cn(authAction, "mt-5")}
            size="lg"
            disabled={busy}
            onClick={() => void complete()}
          >
            {busy ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
            {labels.button}
          </Button>
          {error ? <AuthAlert className="mt-3">{error}</AuthAlert> : null}
        </>
      )}
    </AuthShell>
  );
}
