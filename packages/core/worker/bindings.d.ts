import type { CoreEnv } from "../alchemy/index";

declare global {
  /**
   * The Worker's bindings: core's, derived from what `OpenWorkspace`
   * declares (`CoreEnv`, alchemy/index.ts). Modules add theirs by extending
   * `Env` the same way.
   */
  interface Env extends CoreEnv {}

  namespace Cloudflare {
    interface Env extends globalThis.Env {}
  }
}
