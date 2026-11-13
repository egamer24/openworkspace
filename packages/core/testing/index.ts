/// <reference path="../worker/workers-runtime.d.ts" />
/// <reference path="../worker/bindings.d.ts" />
/**
 * `@open-workspace/core/testing`: stack tests for a module, in the `bun test`
 * process. `testWorkspaceStack` declares a workspace with the module and a
 * test Worker (`@open-workspace/core/testing/worker`); `deployTestStack`,
 * called from the preload, deploys it once per run on Alchemy's local
 * runtime. Test files reach it over HTTP (`worker.fetch`), through the test
 * routes (`hooks`, `env.DB`), and answer its outgoing requests (`internet`).
 */
export { deployTestStack, testStage, testWorkspaceStack } from "./harness";

export {
  bucket,
  env,
  hook,
  hooks,
  ORIGIN,
  useFreshWorkspace,
  worker,
} from "./client";

export {
  internet,
  type OutboundHandler,
  type OutboundRequest,
} from "./internet";

export {
  MCP_TEST_ORIGIN,
  MCP_TEST_REDIRECT,
  mcpAccessToken,
  pkcePair,
  registerMcpClient,
} from "./mcp-oauth";

export { poll, type PollOptions } from "./poll";
