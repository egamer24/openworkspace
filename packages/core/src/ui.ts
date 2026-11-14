/* oxlint-disable oxc/no-barrel-file -- the package's public UI entry point */
/// <reference types="vite/client" />
/// <reference path="../worker/workers-runtime.d.ts" />
/// <reference path="../worker/bindings.d.ts" />
/// <reference path="./client-modules.d.ts" />
/**
 * `@open-workspace/core/ui`: what a module's part of the browser app builds
 * on. Its `ClientModule` contract, the workspace's UI components (shadcn on
 * Base UI, styled by core's theme), the panels settings and admin sections
 * are made of, the app switcher, the signed-in person, and the API client.
 * Browser code only; Worker code imports `@open-workspace/core/module`.
 */

// The contract.
export type { ClientModule, TeamAddress, UserAddress } from "./modules";

// UI components.
export * from "./components/ui/alert-dialog";

export * from "./components/ui/avatar";

export * from "./components/ui/badge";

export * from "./components/ui/button";

export * from "./components/ui/calendar";

export * from "./components/ui/checkbox";

export * from "./components/ui/combobox";

export * from "./components/ui/date-time-picker";

export * from "./components/ui/dialog";

export * from "./components/ui/dropdown-menu";

export * from "./components/ui/input";

export * from "./components/ui/input-group";

export * from "./components/ui/label";

export * from "./components/ui/popover";

export * from "./components/ui/radio-group";

export * from "./components/ui/sheet";

export * from "./components/ui/skeleton";

export * from "./components/ui/switch";

export * from "./components/ui/tabs";

export * from "./components/ui/textarea";

export * from "./components/ui/toggle";

export * from "./components/ui/toggle-group";

export * from "./components/ui/tooltip";

export { cn, initials } from "./lib/utils";

// The app's shell: settings and admin panels, the app bar's pieces.
export {
  AdminListEmpty,
  adminListClass,
  AdminPanelBody,
  adminPanelClass,
  AdminPanelFooter,
  AdminPanelHeader,
} from "./admin/admin-panel";

export { AppSwitcher } from "./components/app-switcher";

export { AppearanceMenuRow } from "./components/appearance-menu-row";

export { useWorkspaceBrand, WorkspaceLogo } from "./components/workspace-logo";

// The session and hooks.
export { useAddressSection } from "./admin/address-sections";

export type { AddressSection } from "./admin/address-sections";

export { useAuth } from "./auth/auth-context";

export { type ConfirmOptions, useConfirm } from "./hooks/use-confirm";

export { useDebouncedValue } from "./hooks/use-debounced-value";

export { useActiveInView, useEdgeFade } from "./hooks/use-scroll-edges";

export { preloadable } from "./lib/preloadable";

// The API: core's typed client, and the fetch and helpers a module's own
// client (`hc<typeof itsRoutes>(origin, { fetch: apiFetch })`) uses.
export {
  api,
  ApiError,
  apiFetch,
  noteD1Bookmark,
  responseJson,
  type SuccessfulResponse,
} from "./lib/api";
