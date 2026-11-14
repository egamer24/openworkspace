import type { QueryClient } from "@tanstack/react-query";
import type { JSONValue } from "hono/utils/types";
import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import modules from "virtual:open-workspace/modules";

import type { WebhookEventDeclaration } from "../shared/webhooks";
import type { MailboxDelivery, WorkspacePermission } from "../shared/workspace";

/**
 * A module's part of the browser app. A module's client entry default-exports
 * one; `OpenWorkspace` builds the app from core's UI and the entries of the
 * listed modules at deploy time. Keep the entry light: lazy-load screens.
 * Styles the module needs are imported from its entry.
 */
export type ClientModule = {
  name: string;
  /** What a signed-in person sees at "/"; the first module's wins. */
  home?: {
    /** Named in "Back to …" links, e.g. "mail". */
    label: string;
    Component: ComponentType;
  };
  /** The module's app in the app switcher, e.g. Mail at "/". */
  app?: { label: string; Icon: LucideIcon; path: string };
  /** More routes for signed-in people, e.g. "/mail/:mailboxId/:folder?/:conversationId?". */
  routes?: { path: string; Component: ComponentType }[];
  /** Settings sections, at /settings/<id>. */
  settings?: {
    /** The section's URL segment: unique among core's and every module's sections. */
    id: string;
    label: string;
    description: string;
    Icon: LucideIcon;
    Component: ComponentType;
  }[];
  /** Administration sections, at /admin/<id>. */
  admin?: {
    /** The section's URL segment: unique among core's and every module's sections. */
    id: string;
    label: string;
    Icon: LucideIcon;
    /** Who may open the section; administrators always can. */
    permission: WorkspacePermission;
    title: string;
    description: string;
    Component: ComponentType;
  }[];
  /**
   * Sections in the editor of a team's saved address, under Administration →
   * Teams, e.g. a shared inbox's signature. Only people who can manage teams
   * see them. A section registers with `useAddressSection({ dirty, save })`,
   * and the editor's "Save address" saves it after the address; `save` uses
   * the module's own routes, guarded with `requirePermission("manage_teams")`.
   */
  teamAddress?: {
    /** Unique among every module's team address sections. */
    id: string;
    Component: ComponentType<{ address: TeamAddress }>;
  }[];
  /**
   * Webhook events the module sends, offered in the webhook editor before
   * core's: the same declaration as its `WorkspaceModule.webhookEvents`.
   */
  webhookEvents?: Record<string, WebhookEventDeclaration>;
  /** Mounted while someone is signed in, e.g. realtime connections. */
  background?: ComponentType;
  /**
   * Starts loading the code of what a signed-in person sees first, e.g. the
   * home screen's lazy chunk (see `preloadable`). Core calls it when the app
   * starts, in parallel with the session check, and shows signed-in screens
   * only once it settled, so no Suspense fallback flashes. No API calls.
   */
  preload?: () => Promise<void>;
  /**
   * Starts the API requests for what the signed-in app is about to show at
   * `pathname`/`search`, e.g. with `queryClient.prefetchQuery`, so they run
   * while screens load. Called once the account is known (again if it
   * changes); errors are the module's to ignore.
   */
  prefetch?: (context: {
    queryClient: QueryClient;
    pathname: string;
    search: URLSearchParams;
  }) => void;
  /**
   * Puts the module's part of the app's startup data (what its
   * `WorkspaceModule.bootstrap` loaded on the server for the URL) into the
   * query cache, under the keys its screens read, so they do not ask again.
   * Called before signed-in screens render, once per account. `data` is the
   * JSON of what that `bootstrap` returned.
   */
  seed?: (context: { queryClient: QueryClient; data: JSONValue }) => void;
  /** Runs after sign-in (and on reconnect); retried on failure. */
  afterSignIn?: () => Promise<void>;
  /**
   * Runs before sign-out, while the session still works, e.g. to drop this
   * device's push subscription. Sign-out goes ahead even if it fails.
   */
  beforeSignOut?: () => Promise<void>;
};

/** A team's address, as a module's `teamAddress` section gets it. */
export type TeamAddress = {
  mailboxId: string;
  address: string;
  displayName: string;
  /**
   * A shared inbox, or a mailing list that copies mail to members: the
   * editor's current choice, which may not be saved yet.
   */
  delivery: MailboxDelivery;
  teamId: string;
};

/** The modules built into this app, in the order they were listed. */
export function clientModules(): readonly ClientModule[] {
  // Read lazily: module entries import core's UI, so this binding may not
  // be initialized while modules load.
  return modules;
}

let preloading: Promise<void> | undefined;
let preloaded = false;

/** Starts every module's `preload` once; settles when all did, failed or not. */
export function preloadModules() {
  preloading ??= Promise.all(
    clientModules().map(async (module) => {
      try {
        await module.preload?.();
      } catch (error) {
        // The screen's own lazy import retries and reports it.
        console.error(`Module ${module.name} could not preload`, error);
      }
    })
  ).then(() => {
    preloaded = true;
  });

  return preloading;
}

export function modulesPreloaded() {
  return preloaded;
}

/** Lets every module start loading what `location` shows; failures are logged. */
export function prefetchModules(
  queryClient: QueryClient,
  location: { pathname: string; search: string }
) {
  for (const module of clientModules()) {
    try {
      module.prefetch?.({
        queryClient,
        pathname: location.pathname,
        search: new URLSearchParams(location.search),
      });
    } catch (error) {
      console.error(`Module ${module.name} could not prefetch`, error);
    }
  }
}

/** Gives every module its part of the startup data; failures are logged. */
export function seedModules(
  queryClient: QueryClient,
  slices: Readonly<Record<string, JSONValue>>
) {
  for (const module of clientModules()) {
    if (!module.seed || !(module.name in slices)) continue;

    try {
      module.seed({ queryClient, data: slices[module.name] });
    } catch (error) {
      console.error(
        `Module ${module.name} could not use its startup data`,
        error
      );
    }
  }
}

/** Lets every module clean up before sign-out; failures do not stop it. */
export async function beforeSignOut() {
  await Promise.all(
    clientModules().map(async (module) => {
      try {
        await module.beforeSignOut?.();
      } catch (error) {
        console.error(
          `Module ${module.name} could not prepare for sign-out`,
          error
        );
      }
    })
  );
}

/** What "Back to …" links name the signed-in home. */
export function homeLabel() {
  return clientModules().find((module) => module.home)?.home?.label ?? "home";
}
