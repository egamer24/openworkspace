import * as Test from "@alchemy.run/test/Core";
import type { StackDefinition } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { defineConfig, devices } from "playwright/test";
import type { FullConfig } from "playwright/test";

import { providers } from "../alchemy/index.ts";
import { required } from "../shared/invariant.ts";
import { destroyWithLocalObjects } from "./local-objects.ts";

/**
 * A package's Playwright suite: its test/e2e/*.spec.ts against the package's own
 * dev stack (dev/alchemy.run.ts), deployed locally on the `e2e_$USER` stage.
 * Each package gives the suite its own port, so it runs alongside
 * `bun run dev` and the other package's suite. Desktop and mobile projects.
 */
export function e2eConfig(props: { port: number }) {
  return defineConfig({
    testDir: ".",
    fullyParallel: false,
    workers: 1,
    retries: 0,
    // Deploys the stack locally on a fresh e2e stage and tears it down after.
    globalSetup: "./global-setup.ts",
    // Traces and failure output stay inside the suite (gitignored).
    outputDir: "./test-results",
    use: {
      baseURL: `http://localhost:${Number(process.env.E2E_PORT ?? props.port)}`,
      trace: "retain-on-failure",
    },
    projects: [
      { name: "desktop", use: { ...devices["Desktop Chrome"] } },
      {
        name: "mobile",
        use: { ...devices["iPhone 13"], browserName: "chromium" },
      },
    ],
  });
}

/** The stage e2e suites deploy on: `E2E_STAGE`, else `e2e_$USER`. */
export const e2eStage = () =>
  process.env.E2E_STAGE ??
  `e2e_${process.env.USER ?? process.env.USERNAME ?? "unknown"}`;

type DevStack = {
  default: Parameters<typeof Test.deploy>[1] & StackDefinition<never>;
  stackName: string;
};

/**
 * The global setup of a package's suite: deploys the package's dev stack
 * with Alchemy's test harness (dev mode, the e2e stage) and keeps it serving
 * until the run ends. Destroying it first means every run starts from
 * migrations and the demo seed, and the Worker's local Durable Object
 * storage, which a local destroy keeps, is removed too; otherwise mailboxes
 * would carry mail over. Returns the teardown.
 */
export async function deployE2eStack(
  config: FullConfig,
  load: () => Promise<DevStack>
) {
  const baseURL = required(
    config.projects[0]?.use.baseURL,
    "The e2e config's first project has a baseURL (e2eConfig sets it)"
  );

  // The dev stack reads these when it deploys.
  process.env.PORT = new URL(baseURL).port;
  process.env.ALLOW_MOCK_AUTH = "true";
  // The stack's hostname is the host the browser opens, so OIDC and SAML sign for baseURL.
  process.env.DEV_HOST = new URL(baseURL).hostname;
  const { default: stack, stackName } = await load();
  const stage = e2eStage();

  const options: Test.MakeOptions = {
    providers: providers(),
    dev: true,
    stage,
  };

  const scope = Scope.makeUnsafe("sequential");
  const sidecar = Test.makeSidecarHandle(options);

  const run = <A>(effect: Test.TestEffect<A>) =>
    Test.run(effect, options, scope, sidecar);

  const close = () =>
    Effect.runPromise(
      Effect.andThen(
        Scope.close(scope, Exit.void),
        sidecar?.close ?? Effect.void
      )
    );

  const destroy = () =>
    destroyWithLocalObjects(stackName, stage, () =>
      run(Test.destroy(options, stack, { scope }))
    );

  try {
    await destroy();

    const { workerUrl: url } = await run(
      Test.deploy(options, stack, { scope })
    );

    if (!url || new URL(url).port !== process.env.PORT) {
      throw new Error(`The e2e stack serves ${url}, not ${baseURL}`);
    }
  } catch (error) {
    await close();
    throw error;
  }

  return async () => {
    try {
      await destroy();
    } finally {
      await close();
    }
  };
}
