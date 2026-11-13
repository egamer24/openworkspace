import { demoSeed, devWorkspaceStack } from "./stack.ts";

/**
 * Core alone, with no modules: `bun run dev` in packages/core serves it on
 * port 5175 with the demo, and core's e2e suite deploys it on its own stage.
 */
const { stack, stackName } = devWorkspaceStack({
  stack: "OpenWorkspaceCoreDev",
  seed: [demoSeed],
  port: 5175,
});

export { stackName };

export default stack;
