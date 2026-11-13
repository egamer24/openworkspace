import { e2eConfig } from "../../testing/e2e.ts";

// Its own port, so a run can go alongside `bun run dev` and email's suite.
export default e2eConfig({ port: 5176 });
