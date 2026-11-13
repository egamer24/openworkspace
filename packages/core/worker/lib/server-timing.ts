import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { AppEnv } from "../env";

/** One measured wait, e.g. a D1 query or a Durable Object call. */
export type ServerTimingEntry = { name: string; dur: number; desc?: string };

/**
 * Collects `Server-Timing` entries for /api responses, so DevTools shows what
 * each request waited on (`d1`, `do`, `r2`, ...). Parallel waits are listed
 * separately; `total` is the wall time spent in the Worker.
 */
export const serverTiming = createMiddleware<AppEnv>(async (c, next) => {
  const entries: ServerTimingEntry[] = [];
  c.set("serverTiming", entries);
  const start = performance.now();
  await next();

  // WebSocket upgrades and some streamed responses have immutable headers.
  if (c.res.status === 101) return;
  entries.push({ name: "total", dur: performance.now() - start });

  try {
    c.res.headers.append("server-timing", entries.map(formatEntry).join(", "));
  } catch {
    // Immutable headers (e.g. a fetched response passed through).
  }
});

function formatEntry(entry: ServerTimingEntry) {
  const parts = [entry.name, `dur=${entry.dur.toFixed(1)}`];

  if (entry.desc) {
    parts.push(`desc=${JSON.stringify(entry.desc.replaceAll(/["\\]/gu, ""))}`);
  }

  return parts.join(";");
}

/** Measures `work` as one `Server-Timing` entry of the current request. */
export async function timed<T>(
  c: Context<AppEnv>,
  name: string,
  desc: string,
  work: () => Promise<T>
): Promise<T> {
  const entries = c.get("serverTiming");

  if (!entries) return work();
  const start = performance.now();

  try {
    return await work();
  } finally {
    entries.push({ name, desc, dur: performance.now() - start });
  }
}
