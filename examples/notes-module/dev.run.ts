import { demoSeed, devWorkspaceStack } from "@open-workspace/core/dev";

import { Notes } from "./modules/notes/alchemy.ts";

/**
 * The workspace on your machine with core's demo (`bun run dev`): no
 * Cloudflare account, the demo sign-in, and Notes. The e2e suite deploys
 * the same stack on its own stage.
 */
const { stack, stackName } = devWorkspaceStack({
  stack: "NotesExampleDev",
  modules: [Notes()],
  seed: [demoSeed],
  port: Number(process.env.PORT ?? 5180),
});

export { stackName };

export default stack;
