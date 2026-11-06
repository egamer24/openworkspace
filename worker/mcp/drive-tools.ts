import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createDriveLinkSchema, driveIdSchema, driveListQuerySchema } from "../drive/schemas";
import { AccountApiClient, apiPath } from "./account-client";
import { runTool } from "./results";

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function registerDriveTools(server: McpServer, api: AccountApiClient) {
  server.registerTool(
    "list_drive_items",
    {
      title: "List or search Drive items",
      description: "List a Drive folder (root when parentId is omitted), the trash, items shared with the current account, or search the account's own files by name.",
      inputSchema: driveListQuerySchema,
      annotations: readOnly,
    },
    (input) => runTool(() => api.json(apiPath("/drive/items", input))),
  );

  server.registerTool(
    "get_drive_item",
    {
      title: "Get Drive item metadata",
      description: "Get one Drive file or folder with the current account's role and its folder path.",
      inputSchema: z.object({ itemId: driveIdSchema }),
      annotations: readOnly,
    },
    ({ itemId }) => runTool(() => api.json(`/drive/items/${encodeURIComponent(itemId)}`)),
  );

  server.registerTool(
    "create_drive_share_link",
    {
      title: "Create a public Drive link",
      description: "Create a public /d/<token> link to a file the current account owns. expiresAt is a Unix time in milliseconds. The URL is returned once.",
      inputSchema: createDriveLinkSchema.extend({ itemId: driveIdSchema }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ itemId, ...link }) => runTool(() => api.json(
      `/drive/items/${encodeURIComponent(itemId)}/links`,
      { method: "POST", json: link },
    )),
  );
}
