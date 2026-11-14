import { deployTestStack } from "@open-workspace/core/testing";

// Email Routing's API is faked per test (fake-email-routing.ts); these only
// make the Worker call it, as a deployed one with its minted token would.
process.env.EMAIL_ROUTING_ACCOUNT_ID ??= "test-account";

process.env.EMAIL_ROUTING_API_TOKEN ??= "test-token";

// Preloaded by `bun run test:stack`: email's stack (core and the mail module), deployed once for the run.
await deployTestStack(() => import("./stack.ts"));
