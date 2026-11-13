/// <reference path="../worker/workers-runtime.d.ts" />
/// <reference path="../worker/bindings.d.ts" />
/**
 * `@open-workspace/core/testing/worker`: the test Worker of a module's stack
 * suite, which runs inside the Worker. Its `test/stack/worker.ts`
 * default-exports `testWorker({ hooks })`, and `testWorkspaceStack` passes
 * that file as `wrap`, so the test routes sit in front of the workspace.
 */
export {
  clearBucket,
  type HookContext,
  type TestHook,
  type TestHookOptions,
  type TestRoute,
  testWorker,
} from "./test-hooks";

export { consumeWebhooks } from "../worker/webhooks/delivery";
