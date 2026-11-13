import { KeyRound, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

import {
  DomainAddressInput,
  useDomainAddress,
} from "../components/domain-address-input";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useAuth } from "./auth-context";
import {
  AuthAlert,
  AuthDemoOption,
  AuthHeading,
  AuthShell,
  authAction,
} from "./auth-shell";
import { passkeyErrorMessage } from "./passkey-error";

/** Signing in, or, on a fresh installation, creating the first administrator. */
export function AuthScreen() {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);

    try {
      await action();
    } catch (failure) {
      setError(passkeyErrorMessage(failure, fallback));
    }

    setBusy(false);
  }

  return (
    <AuthShell
      footnote={
        auth.needsBootstrap
          ? "Your browser saves a passkey for this workspace. There is no password."
          : "Lost your passkey? Ask an administrator for a recovery link."
      }
    >
      {auth.needsBootstrap ? (
        <SetupForm busy={busy} error={error} run={run} />
      ) : (
        <SignIn busy={busy} error={error} run={run} />
      )}
    </AuthShell>
  );
}

type Run = (action: () => Promise<void>, fallback: string) => Promise<void>;

function SignIn({
  busy,
  error,
  run,
}: {
  busy: boolean;
  error: string | null;
  run: Run;
}) {
  const auth = useAuth();

  return (
    <>
      <AuthHeading
        title="Sign in to your workspace"
        description="Use the passkey saved on this device, your phone, or a security key."
      />
      <div className="mt-7 space-y-3.5">
        <Button
          className={authAction}
          size="lg"
          disabled={busy}
          onClick={() => void run(() => auth.login(), "Could not sign in")}
        >
          {busy ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
          Continue with passkey
        </Button>
        {auth.mockAuthEnabled ? (
          <AuthDemoOption>
            <Button
              className={authAction}
              variant="outline"
              size="lg"
              disabled={busy}
              onClick={() =>
                void run(() => auth.login(true), "Could not open the demo")
              }
            >
              Open seeded local demo
            </Button>
          </AuthDemoOption>
        ) : null}
        {error ? <AuthAlert>{error}</AuthAlert> : null}
      </div>
    </>
  );
}

function SetupForm({
  busy,
  error,
  run,
}: {
  busy: boolean;
  error: string | null;
  run: Run;
}) {
  const auth = useAuth();
  const [name, setName] = useState("");
  const email = useDomainAddress(auth.setupMailDomains);

  function create(demo?: true) {
    const { address } = email;

    if (!address) return;
    void run(
      () => auth.bootstrap({ name, email: address }, demo),
      demo ? "Could not create the demo" : "Could not create the account"
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    create();
  }

  return (
    <>
      <AuthHeading
        title="Set up your workspace"
        description="Create the first administrator. You'll invite people and manage the workspace from this account."
      />
      <form className="mt-7 space-y-5 text-left" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor="setup-name">Full name</Label>
          <Input
            id="setup-name"
            className="h-10"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            minLength={2}
            maxLength={80}
            autoComplete="name"
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="setup-email">Email address</Label>
          <DomainAddressInput
            id="setup-email"
            className="h-10"
            field={email}
            placeholder="you"
            describedBy="setup-email-hint"
            required
          />
          {email.error ? null : (
            <p
              id="setup-email-hint"
              className="text-muted-foreground text-xs leading-5 text-pretty"
            >
              Your personal mailbox.
            </p>
          )}
        </div>
        <div className="space-y-3.5 pt-1">
          <Button
            className={authAction}
            type="submit"
            size="lg"
            disabled={busy}
          >
            {busy ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
            Create with passkey
          </Button>
          {auth.mockAuthEnabled ? (
            <AuthDemoOption>
              <Button
                className={authAction}
                type="button"
                variant="outline"
                size="lg"
                disabled={busy}
                onClick={(event) => {
                  // The browser checks the fields for the submit button only.
                  if (event.currentTarget.form?.reportValidity()) create(true);
                }}
              >
                Create local demo without passkey
              </Button>
            </AuthDemoOption>
          ) : null}
          {error ? <AuthAlert>{error}</AuthAlert> : null}
        </div>
      </form>
    </>
  );
}
