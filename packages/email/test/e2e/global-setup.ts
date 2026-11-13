import { deployE2eStack } from "@open-workspace/core/testing/e2e";
import type { FullConfig } from "playwright/test";

// Email's dev stack: core and the mail module.
const globalSetup = (config: FullConfig) =>
  deployE2eStack(config, () => import("../../dev/alchemy.run.ts"));

export default globalSetup;
