import { useMutation } from "@tanstack/react-query";
import { LogOut, Settings, ShieldCheck } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";

import { useAuth } from "./auth/auth-context";
import { AuthHeading, AuthShell, authAction } from "./auth/auth-shell";
import { Button, buttonVariants } from "./components/ui/button";
import { cn } from "./lib/utils";

/** The signed-in home when no module provides one. */
export function HomePage() {
  const auth = useAuth();

  const signOut = useMutation({
    mutationFn: auth.logout,
    onError: (error) => toast.error(error.message),
  });

  const link = cn(
    buttonVariants({ variant: "outline", size: "lg" }),
    authAction,
    "justify-start"
  );

  return (
    <AuthShell>
      <AuthHeading
        title={auth.user?.name ? `Hello, ${auth.user.name}` : "Hello"}
        description="You're signed in to this workspace."
      />
      <div className="mt-6 flex flex-col gap-2">
        <Link className={link} to="/settings">
          <Settings /> Settings
        </Link>
        {auth.user?.permissions.length ? (
          <Link className={link} to="/admin">
            <ShieldCheck /> Administration
          </Link>
        ) : null}
        <Button
          className={cn(authAction, "justify-start")}
          variant="ghost"
          size="lg"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          <LogOut /> Sign out
        </Button>
      </div>
    </AuthShell>
  );
}
