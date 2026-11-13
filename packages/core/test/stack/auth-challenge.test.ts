import { describe, expect, it } from "bun:test";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { env, hooks, useFreshWorkspace, worker } from "../../testing/client.ts";
import { createDb } from "../../worker/db/client.ts";
import {
  authChallenges,
  passkeyCredentials,
  users,
} from "../../worker/db/schema.ts";

useFreshWorkspace();

/** Runs a challenge-store function in the Worker (stack/hooks.ts). */
async function inWorker<T>(name: string, ...args: unknown[]) {
  const result = await hooks.call<{ value?: T; error?: string }>(
    `identity.${name}`,
    ...args
  );

  if (result.error !== undefined) throw new Error(result.error);

  return result.value;
}

const consumeChallenge = async (id: string, kind: "authentication") =>
  required(
    await inWorker<{ id: string }>("consumeChallenge", id, kind),
    "consumeChallenge returns the challenge it consumed"
  );

const bootstrapOptions = z.object({
  ok: z.literal(true),
  challengeId: z.string(),
});

function challenge(id: string, expiresAt: Date) {
  return {
    id,
    challenge: `nonce-${id}`,
    kind: "authentication" as const,
    rpId: "example.test",
    origin: "https://example.test",
    expiresAt,
  };
}

describe("WebAuthn challenges", () => {
  it("returns independent bootstrap challenges without a shared cookie", async () => {
    const request = () =>
      new Request("http://example.test/api/auth/bootstrap/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Bootstrap Admin",
          email: "bootstrap@example.test",
        }),
      });

    const responses = await Promise.all([
      worker.fetch(request()),
      worker.fetch(request()),
    ]);

    const bodies = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toBeNull();

        return bootstrapOptions.parse(await response.json());
      })
    );

    expect(bodies[0].challengeId).not.toBe(bodies[1].challengeId);

    const db = createDb(env.DB);
    const rows = await db.select().from(authChallenges);
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      expect(row.kind).toBe("bootstrap");
      expect(row.userId).toBeNull();
      expect(row.payload).toMatchObject({
        name: "Bootstrap Admin",
        email: "bootstrap@example.test",
        userId: expect.stringMatching(/^usr_/u),
      });
    }
  });

  it("ties passkeys to the configured hostname, whatever host the request came in on", async () => {
    // The Worker is reachable on other hosts too (workers.dev, say).
    const response = await worker.fetch(
      new Request("http://elsewhere.test/api/auth/bootstrap/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Bootstrap Admin",
          email: "bootstrap@example.test",
        }),
      })
    );

    expect(response.status).toBe(200);

    const body = bootstrapOptions
      .extend({ options: z.object({ rp: z.object({ id: z.string() }) }) })
      .parse(await response.json());

    expect(body.options.rp.id).toBe("example.test");

    const [row] = await createDb(env.DB)
      .select()
      .from(authChallenges)
      .where(eq(authChallenges.id, body.challengeId));

    expect(row).toMatchObject({
      rpId: "example.test",
      origin: "http://example.test",
    });
  });

  it("atomically consumes and deletes a valid challenge", async () => {
    const db = createDb(env.DB);
    const id = "chl_delete_after_consume";
    await db
      .insert(authChallenges)
      .values(challenge(id, new Date(Date.now() + 60_000)));

    const consumed = await consumeChallenge(id, "authentication");

    expect(consumed.id).toBe(id);
    expect(
      await db.select().from(authChallenges).where(eq(authChallenges.id, id))
    ).toEqual([]);
    await expect(consumeChallenge(id, "authentication")).rejects.toThrow(
      "Passkey ceremony has expired"
    );
  });

  it("deletes an expired challenge when it is presented", async () => {
    const db = createDb(env.DB);
    const id = "chl_delete_after_expiry";
    await db
      .insert(authChallenges)
      .values(challenge(id, new Date(Date.now() - 1000)));

    await expect(consumeChallenge(id, "authentication")).rejects.toThrow(
      "Passkey ceremony has expired"
    );
    expect(
      await db.select().from(authChallenges).where(eq(authChallenges.id, id))
    ).toEqual([]);
  });

  it("removes abandoned expired challenges during cleanup", async () => {
    const db = createDb(env.DB);
    const id = "chl_delete_during_cleanup";
    await db
      .insert(authChallenges)
      .values(challenge(id, new Date(Date.now() - 1000)));

    await inWorker("deleteExpiredChallenges");

    expect(
      await db.select().from(authChallenges).where(eq(authChallenges.id, id))
    ).toEqual([]);
  });

  it("never decreases a passkey counter when updates complete out of order", async () => {
    const db = createDb(env.DB);
    const userId = "usr_counter_race";
    const credentialId = "credential_counter_race";
    await db.insert(users).values({
      id: userId,
      name: "Counter Race",
      role: "member",
      status: "active",
    });
    await db.insert(passkeyCredentials).values({
      credentialId,
      userId,
      publicKey: "unused",
      counter: 1,
      deviceType: "singleDevice",
      backedUp: false,
    });

    await inWorker("recordPasskeyUses", credentialId, [10, 5]);

    const [credential] = await db
      .select({ counter: passkeyCredentials.counter })
      .from(passkeyCredentials)
      .where(eq(passkeyCredentials.credentialId, credentialId));

    expect(credential?.counter).toBe(10);
  });
});
