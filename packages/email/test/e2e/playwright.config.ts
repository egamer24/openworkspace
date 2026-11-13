import { e2eConfig } from "@open-workspace/core/testing/e2e";

// Its own port, so a run can go alongside `bun run dev` (5173) and core's suite.
export default e2eConfig({ port: 5174 });
