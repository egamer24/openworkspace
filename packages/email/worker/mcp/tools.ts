import type { McpToolRegistrar } from "@open-workspace/core/module";

import { registerMailActionTools } from "./mail-action-tools";
import { registerMailComposeTools } from "./mail-compose-tools";
import { registerMailQueryTools } from "./mail-query-tools";
import {
  registerAdminSafetyTools,
  registerMailSafetyTools,
} from "./mail-safety-tools";

/** Mail tools; each declares the scope it needs, so a token sees only what it was granted. */
export const registerMailTools: McpToolRegistrar = (tool, input) => {
  registerMailQueryTools(tool, input.api);
  registerMailActionTools(tool, input.api);
  registerMailComposeTools(tool, input.api);
  registerMailSafetyTools(tool, input.api);
  registerAdminSafetyTools(tool, input.api);
};
