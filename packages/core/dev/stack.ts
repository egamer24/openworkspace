import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

import { OpenWorkspace, providers } from "../alchemy/index.ts";
import type { OpenWorkspaceProps } from "../alchemy/index.ts";

/** Core's demo: people, teams, their addresses on the primary mail domain, and access links. */
export const demoSeed = path.join(import.meta.dirname, "seed/demo.sql");

/** The one mail domain of the local stacks, so its primary; the demo seed's addresses are on it. */
export const DEMO_DOMAIN = "demo.example";

/**
 * The seed files with `{{domain}}` replaced by the stack's primary mail
 * domain (the first in `mailDomains`), written under the package's
 * `.alchemy/seed`, so the SQL never restates it and every seeded address is
 * on a configured domain.
 */
function renderSeeds(files: string[], domain: string) {
  const dir = path.join(process.cwd(), ".alchemy", "seed");
  mkdirSync(dir, { recursive: true });

  return files.map((file) => {
    const target = path.join(dir, path.basename(file));
    writeFileSync(
      target,
      readFileSync(file, "utf-8").replaceAll("{{domain}}", domain)
    );

    return target;
  });
}

/**
 * A package's local workspace stack: `bun run dev` in the package runs it
 * with the demo seed, and the package's e2e suite deploys the same stack on
 * its own stage (see test/e2e/harness.ts). Alchemy's names carry the stack and
 * the stage, so stages never share a Worker, its Durable Objects, queues, or buckets.
 *
 * It reads its settings from the environment when it deploys:
 * `ALLOW_MOCK_AUTH=true` turns on the demo sign-in and the seed, `PORT`
 * overrides the port, and `DEV_HOST` the host its hostname names
 * (`localhost`; the e2e suites use 127.0.0.1, as their browser does).
 */
export function devWorkspaceStack(props: {
  /** Alchemy's stack name; state lives under `.alchemy/state/<stack>/<stage>`. */
  stack: string;
  modules?: OpenWorkspaceProps["modules"];
  /** Backups, so Administration → Backups has a bucket to show. */
  backups?: OpenWorkspaceProps["backups"];
  /** SQL files imported after migrations when the demo sign-in is on. */
  seed: string[];
  /** The local port, unless `PORT` says otherwise. */
  port: number;
}) {
  const stack = Alchemy.Stack(
    props.stack,
    { providers: providers(), state: Alchemy.localState() },
    Effect.gen(function* () {
      const mockAuth = process.env.ALLOW_MOCK_AUTH === "true";
      const mailDomains: [string, ...string[]] = [DEMO_DOMAIN];
      const port = Number(process.env.PORT ?? props.port);

      return yield* OpenWorkspace({
        // The seed's addresses are on the first. Modules skip their
        // Cloudflare-only setup for it under `alchemy dev` (Email Routing
        // and Sending in `Email()`).
        mailDomains,
        // Under `alchemy dev` the app's origin is http://localhost:<port>:
        // what OIDC and SAML sign for and where passkeys work (a browser
        // takes localhost as a secure context). No custom domain is made.
        hostname: `${process.env.DEV_HOST ?? "localhost"}:${port}`,
        modules: props.modules ?? [],
        backups: props.backups,
        mockAuth,
        // Seed files only for the mock-auth demo; OpenWorkspace skips an absent seed.
        seed: mockAuth ? renderSeeds(props.seed, mailDomains[0]) : undefined,
        dev: {
          host: "127.0.0.1",
          port,
        },
      });
    })
  );

  return { stack, stackName: props.stack };
}
