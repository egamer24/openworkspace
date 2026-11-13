import { McpServer } from "@modelcontextprotocol/server";

import type { McpToolRegistrar } from "../modules";
import type { AccountApiClient } from "./account-client";
import { registerAdminTools } from "./admin-tools";
import { scopedTools } from "./scoped-tools";

export function createAccountMcpServer(input: {
  api: AccountApiClient;
  /**
   * The token's scopes the person may still use. Each tool is registered
   * only with the scope it declares; the API checks them again either way.
   */
  scopes: readonly string[];
  /** The installed modules' tools (`WorkspaceModule.mcpTools`), loaded. */
  moduleTools: readonly McpToolRegistrar[];
}) {
  const server = new McpServer(
    {
      name: "openworkspace",
      version: "0.1.0",
    },
    // Tools even when the token's scopes leave none, so the list is empty rather than missing.
    { capabilities: { tools: {} } }
  );

  const tool = scopedTools(server, input.scopes);

  for (const register of input.moduleTools) {
    register(tool, { api: input.api, scopes: input.scopes });
  }

  registerAdminTools(tool, input.api);

  return server;
}
