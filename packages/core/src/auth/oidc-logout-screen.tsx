import { useMutation } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";

import { Button, buttonVariants } from "../components/ui/button";
import { api, responseJson } from "../lib/api";
import { cn } from "../lib/utils";
import { beforeSignOut } from "../modules";
import { useAuth } from "./auth-context";
import { AuthHeading, AuthShell, authAction } from "./auth-shell";

export function OidcLogoutScreen() {
  const auth = useAuth();
  const [params] = useSearchParams();

  const payload = useMemo(
    () => ({
      client_id: params.get("client_id") ?? undefined,
      id_token_hint: params.get("id_token_hint") ?? undefined,
      post_logout_redirect_uri:
        params.get("post_logout_redirect_uri") ?? undefined,
      state: params.get("state") ?? undefined,
    }),
    [params]
  );

  const confirm = useMutation({
    mutationFn: async () => {
      await beforeSignOut();

      return responseJson(await api.api.oidc.logout.$post({ json: payload }));
    },
    onSuccess: ({ redirectTo }) => window.location.assign(redirectTo),
    onError: (error) => toast.error(error.message),
  });

  return (
    <AuthShell>
      <AuthHeading
        title="Sign out of OpenWorkspace?"
        description="An app asked to end your session here. Sign out only if you just chose to sign out of that app."
      />

      <div className="mt-7 flex flex-col gap-2">
        <Button
          className={authAction}
          size="lg"
          disabled={confirm.isPending || !auth.authenticated}
          onClick={() => confirm.mutate()}
        >
          {confirm.isPending ? <LoaderCircle className="animate-spin" /> : null}
          Sign out
        </Button>
        <Link
          to="/"
          className={cn(
            buttonVariants({ variant: "ghost", size: "lg" }),
            authAction
          )}
        >
          Stay signed in
        </Link>
      </div>
    </AuthShell>
  );
}
