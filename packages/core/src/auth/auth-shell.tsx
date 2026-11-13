import { CircleAlert, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { BrandMark } from "../components/brand-mark";
import { buttonVariants } from "../components/ui/button";
import { WorkspaceLogo } from "../components/workspace-logo";
import { cn } from "../lib/utils";
import { useAuth } from "./auth-context";

/** The full-width, 44px action buttons of the screens around signing in. */
export const authAction = "h-11 w-full rounded-lg text-[0.9375rem]";

/**
 * The page for the screens around signing in: links, consent, sign-out.
 * A narrow centered column on a dot grid, the product at the top, the
 * workspace's logo (or the product mark) above the column, and a bottom bar
 * with this workspace's host and an optional `footnote`.
 */
export function AuthShell({
  footnote,
  children,
}: {
  footnote?: ReactNode;
  children: ReactNode;
}) {
  const { workspaceLogoUrl } = useAuth();

  return (
    // The primary action keeps the brand blue in dark mode too, as on the mark.
    <div className="bg-background bg-dot-grid grid min-h-dvh grid-rows-[auto_1fr_auto] px-5 py-6 sm:px-8 sm:py-7 dark:[--primary-foreground:#fff] dark:[--primary:#4f74e6]">
      <header className="flex items-center gap-2.5">
        <BrandMark />
        <span className="text-[0.9375rem] font-semibold tracking-[-0.01em]">
          OpenWorkspace
        </span>
      </header>
      <main className="grid place-items-center py-12">
        <div className="animate-rise w-full max-w-[22.5rem]">
          <WorkspaceLogo
            src={workspaceLogoUrl}
            className="mx-auto mb-5.5 size-12"
          />
          {children}
        </div>
      </main>
      <footer className="text-muted-foreground flex flex-col items-center gap-1.5 text-center text-[0.78125rem] leading-5 sm:flex-row sm:items-end sm:justify-between sm:gap-6 sm:text-left">
        {/* Phones already show the host in the browser's address bar, right next to this. */}
        <span className="hidden font-mono sm:inline">
          {window.location.host}
        </span>
        {footnote ? (
          <p className="text-pretty sm:text-right">{footnote}</p>
        ) : null}
      </footer>
    </div>
  );
}

export function AuthHeading({
  title,
  description,
}: {
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="text-center">
      <h1 className="text-[1.625rem] leading-[1.15] font-semibold tracking-[-0.025em] text-balance">
        {title}
      </h1>
      {description ? (
        <p className="text-muted-foreground mt-2 text-[0.90625rem] leading-[1.55] text-pretty">
          {description}
        </p>
      ) : null}
    </div>
  );
}

/** A failed passkey prompt or request, next to the button that caused it. */
export function AuthAlert({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role="alert"
      className={cn(
        "bg-destructive/8 text-destructive ring-destructive/20 dark:bg-destructive/12 flex items-start gap-2.5 rounded-lg px-3.5 py-3 text-left text-[0.8125rem] leading-5 ring-1",
        className
      )}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 text-pretty">{children}</span>
    </p>
  );
}

export function AuthLoading() {
  return (
    <div
      className="grid place-items-center py-8"
      role="status"
      aria-label="Loading"
    >
      <LoaderCircle className="text-muted-foreground animate-spin" />
    </div>
  );
}

/** Mock sign-in exists only in local development; it is set apart from the real one. */
export function AuthDemoOption({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-3.5">
      <div
        className="text-muted-foreground flex items-center gap-3 text-xs"
        aria-hidden="true"
      >
        <span className="bg-border h-px flex-1" />
        Local development
        <span className="bg-border h-px flex-1" />
      </div>
      {children}
    </div>
  );
}

/** A link or request that can't be used: say why, and offer the way back in. */
export function AuthUnavailable({
  title,
  description,
  action = "Go to sign-in",
}: {
  title: string;
  description: ReactNode;
  action?: string;
}) {
  return (
    <>
      <AuthHeading title={title} description={description} />
      <Link
        to="/"
        className={cn(
          buttonVariants({ variant: "outline", size: "lg" }),
          authAction,
          "mt-7"
        )}
      >
        {action}
      </Link>
    </>
  );
}
