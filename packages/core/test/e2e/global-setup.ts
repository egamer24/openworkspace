import type { FullConfig } from "playwright/test";

import { deployE2eStack } from "../../testing/e2e.ts";

// Core's dev stack: core alone, with no modules.
const globalSetup = (config: FullConfig) =>
  deployE2eStack(config, () => import("../../dev/alchemy.run.ts"));

export default globalSetup;
