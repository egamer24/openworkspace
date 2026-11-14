import { demoSeed, devWorkspaceStack } from "@open-workspace/core/dev";

import { Email } from "../alchemy/index.ts";

/**
 * Core and the mail module: `bun run dev` (here or at the repository root)
 * serves it on port 5173 with core's demo, whose mailboxes get their sample
 * mail on the demo sign-in (the module's `seedDemo` hook), and email's e2e
 * suite deploys it on its own stage.
 */
const { stack, stackName } = devWorkspaceStack({
  stack: "OpenWorkspaceEmailDev",
  // Push services take only a mailto: or https: contact, and the local app
  // is served over http. The archive is on so Administration → Mail archive
  // has a bucket to show.
  modules: [
    Email({ pushContact: "mailto:admin@demo.example", archive: { years: 10 } }),
  ],
  // On, so Administration → Backups has a bucket to show.
  backups: {},
  seed: [demoSeed],
  port: 5173,
});

export { stackName };

export default stack;
