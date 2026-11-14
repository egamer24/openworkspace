import path from "node:path";

import { testWorkspaceStack } from "@open-workspace/core/testing";

import { Email } from "../../alchemy/index.ts";
import { emailClasses } from "../../shared/module.ts";

/** Core and the mail module, wrapped by test/stack/worker.ts, whose MailboxDO has test-only methods. */
export const { stack, stackName } = testWorkspaceStack({
  stack: "OpenWorkspaceEmailTest",
  wrap: {
    entry: path.join(import.meta.dirname, "worker.ts"),
    classes: [emailClasses.MAILBOX],
  },
  // Push services need a contact; mailto: as a deployment would give. Trash
  // keeps mail a week, so retention.test.ts covers both folders (Spam's
  // default is 30 days).
  modules: [
    Email({ pushContact: "mailto:test@example.test", retention: { trash: 7 } }),
  ],
  // For backups.test.ts.
  backups: {},
});
