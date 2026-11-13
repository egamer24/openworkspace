import { describe, expect, it } from "bun:test";

import { useFreshWorkspace, worker } from "../../testing/client.ts";

useFreshWorkspace();

const origin = "http://example.test";

async function status(
  path: string,
  init: {
    method?: string;
    ip: string;
    headers?: Record<string, string>;
    json?: unknown;
  }
) {
  const headers = new Headers({ "cf-connecting-ip": init.ip });

  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
  }

  for (const [name, value] of Object.entries(init.headers ?? {})) {
    headers.set(name, value);
  }

  const response = await worker.fetch(
    new Request(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    })
  );

  if (response.status === 429) {
    expect(response.headers.get("retry-after")).toBe("60");
  }

  await response.body?.cancel();

  return response.status;
}

/** Statuses of `count` requests in a row. */
async function burst(count: number, request: () => Promise<number>) {
  const statuses: number[] = [];

  for (let index = 0; index < count; index += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the limiter counts requests in order; the last ones must arrive after the budget is spent
    statuses.push(await request());
  }

  return statuses;
}

describe("rate limits", () => {
  it("throttle first-administrator setup per address", async () => {
    const setup = (ip: string) =>
      status("/api/auth/bootstrap/options", {
        method: "POST",
        ip,
        json: { name: "First Admin", email: "first@example.test" },
      });

    const statuses = await burst(11, () => setup("203.0.113.21"));
    expect(statuses.slice(0, 10).every((code) => code === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Verifying is the same budget.
    expect(
      await status("/api/auth/bootstrap/verify", {
        method: "POST",
        ip: "203.0.113.21",
        json: {},
      })
    ).toBe(429);
    // Another address is not affected.
    expect(await setup("203.0.113.22")).toBe(200);
  });

  it("throttle invitation and recovery links per address, whatever X-Forwarded-For says", async () => {
    const statuses = await burst(31, () =>
      status("/api/auth/recovery/not-a-real-token", {
        ip: "203.0.113.31",
        // A client picks its own forwarded address; it must not get a fresh budget.
        headers: {
          "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250)}`,
        },
      })
    );

    expect(statuses.slice(0, 30).every((code) => code === 404)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(
      await status("/api/auth/invitation/not-a-real-token/options", {
        method: "POST",
        ip: "203.0.113.31",
      })
    ).toBe(429);
  });

  it("count an IPv6 network as one address", async () => {
    const lookups = await burst(30, () =>
      status("/api/auth/invitation/not-a-real-token", {
        ip: `2001:db8:77:1::${Math.floor(Math.random() * 0xff_ff).toString(16)}`,
      })
    );

    expect(lookups.every((code) => code === 404)).toBe(true);
    expect(
      await status("/api/auth/invitation/not-a-real-token", {
        ip: "2001:db8:77:1:aaaa::1",
      })
    ).toBe(429);
    expect(
      await status("/api/auth/invitation/not-a-real-token", {
        ip: "2001:db8:77:2::1",
      })
    ).toBe(404);
  });
});
