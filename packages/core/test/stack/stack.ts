import path from "node:path";

import { testWorkspaceStack } from "../../testing/harness.ts";

/** Core alone: a workspace with no modules, wrapped by test/stack/worker.ts. */
export const { stack, stackName } = testWorkspaceStack({
  stack: "OpenWorkspaceCoreTest",
  wrap: { entry: path.join(import.meta.dirname, "worker.ts") },
});
