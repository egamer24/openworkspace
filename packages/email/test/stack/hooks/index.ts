import type { TestHook } from "@open-workspace/core/testing/worker";

import { hooks as mailFlow } from "./mail-flow.ts";
import { hooks as mailbox } from "./mailbox.ts";
import { hooks as realtime } from "./realtime.ts";
import { hooks as worker } from "./worker.ts";

/**
 * Email's named test hooks (`hooks.call(name, ...args)`), for what only
 * code inside the Worker can do: run a module function with a fake built
 * from the real bindings, or one the public API reaches only in passing.
 */
export const emailHooks = {
  ...realtime,
  ...mailbox,
  ...mailFlow,
  ...worker,
} satisfies Record<string, TestHook>;
