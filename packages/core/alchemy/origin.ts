import { z } from "zod";

import { domainName } from "../worker/config/schema.ts";

/** A deployed workspace's `hostname`: a bare domain name such as workspace.example.com. */
const deployedHostname = domainName;

/** RFC 6761's special-use names, which no deployment can have. */
const specialUseName = /\.(?:test|example|invalid|localhost)\.?$/iu;

/**
 * A local stack's `hostname` under `alchemy dev`: a host name or IPv4
 * address with an optional port, e.g. localhost:5173 or example.test.
 */
const localHostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/u,
    "Use a host such as localhost:5173"
  );

/**
 * The app's origin from `hostname`, validated so a mistake fails the
 * deploy: `https://<hostname>`, or `http://<hostname>` under `alchemy dev`,
 * whose local runtime serves plain http.
 */
export function workspaceOrigin(
  hostname: string,
  dev: boolean,
  devServer?: { host?: string; port?: number }
) {
  // A deployment's own project runs `alchemy dev` with its real hostname: the
  // app is then reached on the local dev server, so that is its origin (and
  // where passkeys work). A special-use name such as example.test is never a
  // real deployment's, and stays the origin (the stack tests address it).
  if (
    dev &&
    devServer?.port &&
    deployedHostname.safeParse(hostname).success &&
    !specialUseName.test(hostname.trim())
  ) {
    return `http://${devServer.host ?? "localhost"}:${devServer.port}`;
  }

  const parsed = (dev ? localHostname : deployedHostname).safeParse(hostname);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message).join(", ");

    throw new Error(
      `OpenWorkspace options are invalid:\n  hostname: ${issues}`
    );
  }

  return `${dev ? "http" : "https"}://${parsed.data}`;
}
