import { LoaderCircle, RotateCw } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { AuthHeading, AuthShell, authAction } from "./auth-shell";

/** The session check failed (offline, or the server is down): signed in or not is unknown. */
export function AuthCheckError({ onRetry }: { onRetry: () => Promise<void> }) {
  const [pending, setPending] = useState(false);

  return (
    <AuthShell>
      <AuthHeading
        title="Could not check session"
        description="OpenWorkspace didn't respond. Check your connection, then try again."
      />
      <Button
        className={cn(authAction, "mt-7")}
        size="lg"
        variant="outline"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void onRetry().finally(() => setPending(false));
        }}
      >
        {pending ? <LoaderCircle className="animate-spin" /> : <RotateCw />}
        Retry
      </Button>
    </AuthShell>
  );
}
