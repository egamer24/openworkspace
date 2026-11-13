import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Ban,
  LoaderCircle,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useParams } from "react-router";
import { toast } from "sonner";

import { ACCESS_SCOPE, groupScopes } from "../../shared/oidc";
import type { ScopeInfo } from "../../shared/oidc";
import { Button } from "../components/ui/button";
import { api, responseJson } from "../lib/api";
import {
  AuthHeading,
  AuthLoading,
  AuthShell,
  AuthUnavailable,
  authAction,
} from "./auth-shell";

/** The scopes asked for, under Your profile, the modules' groups (e.g. Mail), People and Administration. */
function ScopeList({ scopes }: { scopes: ScopeInfo[] }) {
  return groupScopes(scopes.filter((scope) => scope.id !== ACCESS_SCOPE)).map(
    ({ group, title, scopes: inGroup }) => (
      <section key={group} className="mt-4 first:mt-0" aria-label={title}>
        <h2 className="text-muted-foreground mb-1.5 text-[0.6875rem] font-semibold tracking-wide uppercase">
          {title}
        </h2>
        <ul className="divide-border bg-surface ring-border divide-y rounded-lg text-left ring-1">
          {inGroup.map((scope) => (
            <li key={scope.id} className="flex gap-3 px-3.5 py-2">
              <ShieldCheck className="text-success mt-0.5 size-4 shrink-0" />
              <div className="min-w-0">
                <p className="text-[0.8125rem] leading-5 font-medium text-pretty">
                  {scope.label}
                </p>
                <p className="text-muted-foreground font-mono text-[0.6875rem]">
                  {scope.id}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    )
  );
}

/** admin.access, set apart: it is enough to take over accounts. */
function AccessWarning({ clientName }: { clientName: string }) {
  return (
    <div
      role="note"
      aria-label="Account takeover risk"
      className="bg-destructive/8 ring-destructive/25 dark:bg-destructive/12 mt-4 rounded-lg px-3.5 py-3 text-left ring-1"
    >
      <p className="text-destructive flex items-center gap-2 text-[0.8125rem] font-semibold">
        <ShieldAlert className="size-4 shrink-0" />
        Full control over people's access
      </p>
      <p className="mt-1.5 text-[0.8125rem] leading-5 text-pretty">
        {clientName} could make anyone an administrator, change what people may
        manage, and create recovery links that take over their accounts,
        including yours. Allow this only for an app you trust with the whole
        workspace.
      </p>
      <p className="text-muted-foreground mt-1 font-mono text-[0.6875rem]">
        {ACCESS_SCOPE}
      </p>
    </div>
  );
}

export function OidcConsentScreen() {
  const { requestId = "" } = useParams();

  const request = useQuery({
    queryKey: ["oidc-consent", requestId],
    queryFn: async () =>
      responseJson(
        await api.api.oidc.consent[":id"].$get({
          param: { id: requestId },
        })
      ),
  });

  const decision = useMutation({
    mutationFn: async (approved: boolean) =>
      responseJson(
        await api.api.oidc.consent[":id"].$post({
          param: { id: requestId },
          json: { approved },
        })
      ),
    onSuccess: ({ redirectTo }) => window.location.assign(redirectTo),
    onError: (error) => toast.error(error.message),
  });

  if (request.isLoading) {
    return (
      <AuthShell>
        <AuthLoading />
      </AuthShell>
    );
  }

  if (request.isError || !request.data) {
    return (
      <AuthShell>
        <AuthUnavailable
          title="Request expired"
          description="This authorization request expired or belongs to another session. Go back to the app and try again."
          action="Go to OpenWorkspace"
        />
      </AuthShell>
    );
  }

  const consent = request.data.request;
  const selfRegistered = consent.clientRegistration !== "admin";

  const workspaceAccess = consent.scopes.some(
    (scope) => scope.group !== "identity"
  );

  const nothingToGrant = consent.scopes.length === 0;

  return (
    <AuthShell>
      {selfRegistered ? (
        <>
          <AuthHeading
            title={`Allow ${consent.clientName} to use your account?`}
            description="An app wants to work with your workspace through OpenWorkspace, on your behalf."
          />
          <dl className="bg-surface ring-border mt-5 grid gap-1 rounded-lg px-3.5 py-2.5 text-left text-xs ring-1">
            {consent.clientHost ? (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Published by</dt>
                <dd className="truncate font-mono text-[0.8125rem] font-semibold">
                  {consent.clientHost}
                </dd>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">Returns you to</dt>
              <dd className="truncate font-mono text-[0.8125rem] font-medium">
                {consent.redirectHost}
              </dd>
            </div>
          </dl>
          <p className="bg-warning/10 ring-warning/25 mt-3 flex items-start gap-2.5 rounded-lg px-3.5 py-3 text-left text-xs leading-5 text-pretty ring-1">
            <TriangleAlert className="text-warning mt-0.5 size-3.5 shrink-0" />
            <span>
              {consent.redirectElsewhere ? (
                <>
                  It sends you back to{" "}
                  <span className="font-mono font-medium">
                    {consent.redirectHost}
                  </span>
                  , not to{" "}
                  <span className="font-mono font-medium">
                    {consent.clientHost}
                  </span>
                  , which published it. That is normal for apps on your own
                  computer; otherwise it may be an impostor.{" "}
                </>
              ) : consent.clientHost ? null : (
                <>The app named itself; OpenWorkspace has not verified it. </>
              )}
              Continue only if you just connected it yourself. You can
              disconnect it any time in Settings → Connected apps.
            </span>
          </p>
        </>
      ) : (
        <AuthHeading
          title={`Continue to ${consent.clientName}`}
          description={
            workspaceAccess
              ? "This application wants to work with your workspace for you, besides confirming who you are."
              : "This application is asking OpenWorkspace to confirm your identity."
          }
        />
      )}

      {nothingToGrant ? (
        <p className="bg-surface ring-border mt-6 rounded-lg px-3.5 py-3 text-left text-[0.8125rem] leading-5 text-pretty ring-1">
          Nothing {consent.clientName} asked for is available to you, so there
          is nothing to allow.
        </p>
      ) : (
        <>
          <p className="text-muted-foreground mt-6 mb-2 text-xs font-medium">
            {consent.clientName} will be able to
          </p>
          <div aria-label="Requested permissions">
            <ScopeList scopes={consent.scopes} />
          </div>
          {consent.scopes.some((scope) => scope.id === ACCESS_SCOPE) ? (
            <AccessWarning clientName={consent.clientName} />
          ) : null}
        </>
      )}

      {consent.unavailableScopes.length ? (
        <section className="mt-4 text-left" aria-label="Not available to you">
          <h2 className="text-muted-foreground mb-1.5 text-[0.6875rem] font-semibold tracking-wide uppercase">
            Not available to you
          </h2>
          <ul className="ring-border ring-dashed space-y-1 rounded-lg px-3.5 py-2.5 ring-1">
            {consent.unavailableScopes.map((scope) => (
              <li
                key={scope.id}
                className="text-muted-foreground flex gap-2.5 text-xs leading-5"
              >
                <Ban className="mt-0.5 size-3.5 shrink-0" />
                <span className="text-pretty">{scope.label}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground mt-1.5 text-xs text-pretty">
            Your role doesn't include these, so the app won't get them.
          </p>
        </section>
      ) : null}

      {nothingToGrant ? (
        <Button
          className={`${authAction} mt-7`}
          variant="outline"
          size="lg"
          disabled={decision.isPending}
          onClick={() => decision.mutate(false)}
        >
          Back to the app
        </Button>
      ) : (
        <div className="mt-7 grid grid-cols-2 gap-3">
          <Button
            className={authAction}
            variant="outline"
            size="lg"
            disabled={decision.isPending}
            onClick={() => decision.mutate(false)}
          >
            Deny
          </Button>
          <Button
            className={authAction}
            size="lg"
            disabled={decision.isPending}
            onClick={() => decision.mutate(true)}
          >
            {decision.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : null}
            {selfRegistered || workspaceAccess ? "Allow" : "Continue"}
          </Button>
        </div>
      )}
    </AuthShell>
  );
}
