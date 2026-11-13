import { deployTestStack } from "@open-workspace/core/testing";

// Preloaded by `bun run test:stack`: email's stack (core and the mail module), deployed once for the run.
await deployTestStack(() => import("./stack.ts"));
