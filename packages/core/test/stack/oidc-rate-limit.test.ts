import { describe, expect, it } from "bun:test";

import { useFreshWorkspace, worker } from "../../testing/client.ts";

useFreshWorkspace();

const issuer = "http://example.test";

/** A token request from a client that does not exist; its status. */
async function unknownClientStatus(clientId: string) {
  const response = await worker.fetch(
    new Request(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
      }),
    })
  );

  await response.body?.cancel();

  return response.status;
}

describe("OIDC endpoint rate limiting", () => {
  it("limits failed client authentication before expensive token work", async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the limiter counts failures in order; all 60 must land before the next one is refused
      expect(await unknownClientStatus(`unknown-${attempt}`)).toBe(401);
    }

    const limited = await worker.fetch(
      new Request(`${issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "unknown-limited",
        }),
      })
    );

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(await limited.json()).toMatchObject({
      error: "temporarily_unavailable",
    });
  });
});
