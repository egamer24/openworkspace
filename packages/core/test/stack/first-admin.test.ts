import { describe, expect, it } from "bun:test";

import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { env, hook, useFreshWorkspace, worker } from "../../testing/client.ts";
import { passkeyRegistration } from "../fixtures/passkey.ts";

useFreshWorkspace();

const origin = "http://example.test";

/** A request to the stack as `host` sends it, past the test client's own mapping of mock sign-in to localhost. */
function asHost(host: string, path: string, init: RequestInit = {}) {
  const url = new URL(path, process.env.STACK_URL);
  const headers = new Headers(init.headers);
  headers.set("host", host);
  headers.set("cf-connecting-ip", "198.51.100.40");

  return fetch(url, { ...init, headers, redirect: "manual" });
}

const users = async () =>
  required(
    await env.DB.prepare("SELECT count(*) AS n FROM users").first<{
      n: number;
    }>(),
    "count(*) returns a row"
  ).n;

const bootstrapInfo = z.object({ mockAuthEnabled: z.boolean() });

const bootstrapOptions = z.object({
  options: z.object({
    challenge: z.string(),
    rp: z.object({ id: z.string().optional() }),
  }),
  challengeId: z.string(),
});

describe("mock sign-in", () => {
  it("answers only on localhost or 127.0.0.1, even with ALLOW_MOCK_AUTH on", async () => {
    await Promise.all(
      ["/api/auth/mock/bootstrap", "/api/auth/mock/login"].map(async (path) => {
        const response = await asHost("example.test", path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Mallory",
            email: "mallory@example.test",
            userId: "usr_demo_admin",
          }),
        });

        expect(response.status, path).toBe(404);
        await response.body?.cancel();
      })
    );

    expect(await users()).toBe(0);

    const remote = bootstrapInfo.parse(
      await (await asHost("mail.example.com", "/api/bootstrap")).json()
    );

    expect(remote.mockAuthEnabled).toBe(false);

    await Promise.all(
      ["localhost", "127.0.0.1:8787"].map(async (host) => {
        const local = bootstrapInfo.parse(
          await (await asHost(host, "/api/bootstrap")).json()
        );

        expect(local.mockAuthEnabled, host).toBe(true);
      })
    );
  });
});

describe("the first administrator", () => {
  it("is created once when two passkey setups finish together", async () => {
    // Two setups, each with its own address, so neither trips over the other's domain.
    const started = await Promise.all(
      ["first@example.test", "rival@secondary.test"].map(async (email) => {
        const response = await worker.fetch(
          new Request(`${origin}/api/auth/bootstrap/options`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: email.split("@")[0], email }),
          })
        );

        expect(response.status).toBe(200);

        return bootstrapOptions.parse(await response.json());
      })
    );

    const finished = await Promise.all(
      started.map(async ({ options, challengeId }) => {
        const response = await worker.fetch(
          new Request(`${origin}/api/auth/bootstrap/verify`, {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify({
              challengeId,
              response: await passkeyRegistration(options, origin),
            }),
          })
        );

        await response.body?.cancel();

        return response.status;
      })
    );

    expect(finished.sort()).toEqual([200, 409]);
    expect(await users()).toBe(1);
    // Nothing of the loser's is left: one domain row per configured domain at most, one mailbox, one passkey.
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM mailboxes").first("n")
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM passkey_credentials"
      ).first("n")
    ).toBe(1);
  });

  it("is created once when two mock setups run together", async () => {
    await hook("reset");

    const statuses = await Promise.all(
      ["first@example.test", "rival@secondary.test"].map(async (email) => {
        const response = await worker.fetch(
          new Request(`${origin}/api/auth/mock/bootstrap`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Admin", email }),
          })
        );

        await response.body?.cancel();

        return response.status;
      })
    );

    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(await users()).toBe(1);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM mailboxes").first("n")
    ).toBe(1);
  });
});
