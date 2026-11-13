import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { localState } from "alchemy/State/LocalState";
import { isResourceState, State } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { z } from "zod";

/**
 * The name Alchemy gave the Worker (the `Workspace` resource) of this stack
 * and stage, from the local state in the working directory's `.alchemy`;
 * undefined when the stage has none deployed.
 */
export function deployedWorkerName(stack: string, stage: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* yield* State;
      const worker = yield* state.get({ stack, stage, fqn: "Workspace" });

      // The Workspace resource's attributes, as Alchemy stored them.
      return z
        .object({ workerName: z.string().optional() })
        .optional()
        .parse(isResourceState(worker) ? worker.attr : undefined)?.workerName;
    }).pipe(
      Effect.provide(localState().pipe(Layer.provide(NodeServices.layer)))
    )
  );
}

/**
 * Removes a Worker's local Durable Object storage. A local destroy keeps it
 * (Alchemy leaves it in `.alchemy/local/<worker>-<class>` until `.alchemy`
 * is removed). Class names start upper case, which keeps one Worker's name
 * from matching another's that merely starts with it.
 * `.alchemy` is the one Alchemy uses: the working directory's.
 */
export function removeLocalObjects(
  workerName: string,
  dotAlchemy = path.resolve(".alchemy")
) {
  const local = path.join(dotAlchemy, "local");
  const prefix = `${workerName}-`;

  for (const entry of existsSync(local)
    ? readdirSync(local, { withFileTypes: true })
    : []) {
    const rest = entry.name.slice(prefix.length);

    if (
      entry.isDirectory() &&
      entry.name.startsWith(prefix) &&
      /^[A-Z]/u.test(rest)
    ) {
      rmSync(path.join(local, entry.name), { recursive: true, force: true });
    }
  }
}

/**
 * Destroys a stack's stage with `destroy`, then removes the local Durable
 * Object storage of the Worker it had, so a later deploy starts from none.
 */
export async function destroyWithLocalObjects<T>(
  stack: string,
  stage: string,
  destroy: () => Promise<T>
) {
  const workerName = await deployedWorkerName(stack, stage);
  await destroy();

  if (workerName) removeLocalObjects(workerName);
}
