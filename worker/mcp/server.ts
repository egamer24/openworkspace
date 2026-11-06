import { McpServer } from "@modelcontextprotocol/server";
import { registerAdminTools } from "./admin-tools";
import { AccountApiClient } from "./account-client";
import { registerDriveTools } from "./drive-tools";
import { registerMailActionTools } from "./mail-action-tools";
import { registerMailComposeTools } from "./mail-compose-tools";
import { registerMailQueryTools } from "./mail-query-tools";

export function createAccountMcpServer(input: {
  api: AccountApiClient;
  isAdmin: boolean;
  driveEnabled: boolean;
}) {
  const server = new McpServer({
    name: "openworkspace",
    version: "0.1.0",
  });
  registerMailQueryTools(server, input.api);
  registerMailActionTools(server, input.api);
  registerMailComposeTools(server, input.api);
  if (input.driveEnabled) registerDriveTools(server, input.api);
  if (input.isAdmin) registerAdminTools(server, input.api);
  return server;
}
