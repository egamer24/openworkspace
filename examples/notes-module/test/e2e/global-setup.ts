import { deployE2eStack } from "@open-workspace/core/testing/e2e";
import type { FullConfig } from "playwright/test";

// Deploys dev.run.ts locally on a fresh e2e stage, and destroys it after the run.
const globalSetup = (config: FullConfig) =>
  deployE2eStack(config, () => import("../../dev.run.ts"));

export default globalSetup;
