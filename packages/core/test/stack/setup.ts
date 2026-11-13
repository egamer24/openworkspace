import { deployTestStack } from "../../testing/harness.ts";

// Preloaded by `bun run test:stack`: core's stack, deployed once for the run.
await deployTestStack(() => import("./stack.ts"));
