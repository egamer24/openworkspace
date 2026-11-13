import { testWorker } from "../../testing/test-hooks.ts";
import { coreHooks } from "./hooks.ts";

// Core's test Worker: the generated entry passes the workspace to this wrap (see stack.ts).
export default testWorker({ hooks: coreHooks });
