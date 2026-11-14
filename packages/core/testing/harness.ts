import { afterEach } from "bun:test";

import * as Test from "@alchemy.run/test/Bun";
import * as Core from "@alchemy.run/test/Core";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

import { OpenWorkspace, providers } from "../alchemy/index.ts";
import type {
  OpenWorkspaceProps,
  WorkspaceServerEntry,
} from "../alchemy/index.ts";
import { required } from "../shared/invariant.ts";
import { internet, serveInternet } from "./internet.ts";
import {
  deployedWorkerName,
  destroyWithLocalObjects,
  removeLocalObjects,
} from "./local-objects.ts";

/**
 * A package's stack suite: its own workspace stack (core alone, or core and
 * a module), deployed once per `bun test` run by the package's preload
 * (test/stack/setup.ts), and the test Worker's wrap (test/stack/worker.ts,
 * `testWorker` from test-hooks.ts), which puts the test routes in front of
 * the workspace in the generated Worker entry.
 */

/** The stage stack suites deploy on: `STACK_TEST_STAGE`, else Alchemy's test stage (`test_$USER`). */
export const testStage = () =>
  process.env.STACK_TEST_STAGE ?? Test.defaultStage();

/**
 * A workspace stack for a stack suite. Alchemy names its resources after
 * the stack and the stage, so each package's stack, the e2e stack, and
 * `bun run dev` never share a Worker, Durable Objects, D1, or buckets.
 */
export function testWorkspaceStack(props: {
  /** Alchemy's stack name; state lives under `.alchemy/state/<stack>/<stage>`. */
  stack: string;
  /** The test Worker's wrap: `entry` default-exports `testWorker(...)`. */
  wrap: WorkspaceServerEntry;
  modules?: OpenWorkspaceProps["modules"];
  /** Turns on backups, for a module's tests of its backup hook. */
  backups?: OpenWorkspaceProps["backups"];
}) {
  const stack = Alchemy.Stack(
    props.stack,
    { providers: providers(), state: Alchemy.localState() },
    Effect.gen(function* () {
      return yield* OpenWorkspace({
        // Two mail domains, primary first. The harness deploys in dev
        // mode, so `Email()` sets up no Email Routing or Sending for them.
        mailDomains: ["example.test", "secondary.test"],
        // The host tests address the Worker by (client.ts): under
        // `alchemy dev` the origin is http://example.test, which OIDC and
        // SAML sign for and passkeys belong to, and no custom domain is made.
        hostname: "example.test",
        modules: props.modules ?? [],
        backups: props.backups,
        wrap: { server: props.wrap },
        mockAuth: true,
        env: {
          // The test process, which answers the Worker's outgoing requests.
          TEST_HOOKS: required(
            process.env.TEST_HOOKS,
            "deployTestStack serves the test process's internet first"
          ),
        },
        dev: { host: "127.0.0.1", port: Number(process.env.PORT) },
      });
    })
  );

  return { stack, stackName: props.stack };
}

/**
 * Deploys the stack once for every stack test file in the run and destroys
 * it when the run ends, with Alchemy's test harness in dev mode (the local
 * runtime). The run starts from a destroyed stack and no Durable Object
 * storage; each test file then empties D1 and buckets (`useFreshWorkspace`).
 * Call it from the bun preload, before any test file loads.
 */
export async function deployTestStack(
  load: () => Promise<ReturnType<typeof testWorkspaceStack>>
) {
  const stage = testStage();

  const free = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });

  const { port } = free;
  free.stop(true);
  // The stack reads these when it deploys.
  process.env.PORT = String(port);
  process.env.TEST_HOOKS = serveInternet();
  const { stack, stackName } = await load();

  const options: Test.MakeOptions = {
    providers: providers(),
    dev: true,
    stage,
  };

  // Whatever an earlier run left behind, before the harness's own deploy.
  const sidecar = Core.makeSidecarHandle(options);

  try {
    await destroyWithLocalObjects(stackName, stage, () =>
      Core.run(Core.destroy(options, stack), options, undefined, sidecar)
    );
  } finally {
    await Effect.runPromise(sidecar?.close ?? Effect.void);
  }

  const { beforeAll, afterAll, deploy, destroy } = Test.make(options);
  beforeAll(
    Effect.gen(function* () {
      // `url` is the app's origin (http://example.test); the Worker itself
      // listens on the local port.
      const { workerUrl: url } = yield* deploy(stack);

      if (!url || new URL(url).port !== String(port)) {
        return yield* Effect.die(
          new Error(`The test stack serves ${url}, not port ${port}`)
        );
      }

      process.env.STACK_URL = url;
    }),
    { timeout: 600_000 }
  );
  afterEach(() => internet.reset());
  afterAll(
    Effect.gen(function* () {
      const workerName = yield* Effect.promise(() =>
        deployedWorkerName(stackName, stage)
      );

      yield* destroy(stack);

      if (workerName) removeLocalObjects(workerName);
    })
  );
}
