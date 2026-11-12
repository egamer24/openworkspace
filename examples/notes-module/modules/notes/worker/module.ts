import type { WorkspaceModule } from "@open-workspace/core/module";

import {
  NOTES_MODULE,
  notesOauthScopes,
  notesPermissions,
  notesWebhookEvents,
} from "../shared/module";
import { notesAccountApi } from "./routes";

/** Notes' Worker half: `Notes()` points the generated Worker entry at the factory (../index.ts). */
export function notes(): WorkspaceModule {
  return {
    name: NOTES_MODULE,
    accountApi: notesAccountApi,
    permissions: notesPermissions,
    oauthScopes: notesOauthScopes,
    webhookEvents: notesWebhookEvents,
    // Loaded with the first MCP request only.
    mcpTools: () => import("./mcp").then((tools) => tools.registerNotesTools),
  };
}
