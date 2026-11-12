import { runTool } from "@open-workspace/core/module";
import type { McpToolRegistrar } from "@open-workspace/core/module";
import { z } from "zod";

import {
  NOTE_BODY_MAX,
  NOTE_TITLE_MAX,
  NOTES_READ_SCOPE,
  NOTES_WRITE_SCOPE,
} from "../shared/module";

/**
 * The module's MCP tools. Each is registered through `tool(scope)`, so a
 * token sees only the tools its scopes allow, and each calls the module's
 * own routes in-process (`api`), which check the person's access again.
 */
export const registerNotesTools: McpToolRegistrar = (tool, { api }) => {
  tool(NOTES_READ_SCOPE)(
    "list_notes",
    {
      title: "List notes",
      description:
        "List the signed-in person's notes, in the order they chose.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => runTool(() => api.json("/notes"))
  );

  tool(NOTES_WRITE_SCOPE)(
    "create_note",
    {
      title: "Create a note",
      description: "Write a note as the signed-in person.",
      inputSchema: z.object({
        title: z.string().min(1).max(NOTE_TITLE_MAX).describe("A short title."),
        body: z
          .string()
          .max(NOTE_BODY_MAX)
          .optional()
          .describe("The note's text."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool(() => api.json("/notes", { method: "POST", json: input }))
  );
};
