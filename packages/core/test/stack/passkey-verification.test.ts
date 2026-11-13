import { describe, expect, it } from "bun:test";

import { z } from "zod";

import { required } from "../../shared/invariant.ts";
import { env, useFreshWorkspace, worker } from "../../testing/client.ts";
import { softwarePasskey, UP } from "../fixtures/passkey.ts";
import type { Tamper } from "../fixtures/passkey.ts";

/**
 * The Worker's checks on passkey ceremonies (worker/auth/webauthn.ts): a
 * registration or a sign-in counts only with the challenge the Worker
 * issued, from the workspace's origin, for its RP ID, with the user
 * verified, and (sign-in) signed by the registered key with a counter that
 * moved forward. Each refused ceremony leaves nothing behind.
 */

useFreshWorkspace();

const origin = "http://example.test";

type Passkey = Awaited<ReturnType<typeof softwarePasskey>>;

/** What the ceremony routes take: who is set up, or a passkey's answer to a challenge. */
type CeremonyBody = {
  name?: string;
  email?: string;
  challengeId?: string;
  response?:
    | Awaited<ReturnType<Passkey["register"]>>
    | Awaited<ReturnType<Passkey["authenticate"]>>;
};

const bootstrapStart = z.object({
  options: z.object({
    challenge: z.string(),
    rp: z.object({ id: z.string().optional() }),
    authenticatorSelection: z
      .object({ userVerification: z.string().optional() })
      .optional(),
  }),
  challengeId: z.string(),
});

const loginStart = z.object({
  options: z.object({
    challenge: z.string(),
    rpId: z.string().optional(),
    userVerification: z.string().optional(),
  }),
  challengeId: z.string(),
});

type LoginStart = z.infer<typeof loginStart>;

/** Each ceremony from its own address, so the setup and sign-in throttles never answer instead of the checks. */
function post(path: string, body: CeremonyBody) {
  const [a, b] = crypto.getRandomValues(new Uint8Array(2));

  return worker.fetch(
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `198.19.${a}.${b}`,
      },
      body: JSON.stringify(body),
    })
  );
}

const count = async (table: string) =>
  required(
    await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{
      n: number;
    }>(),
    "count(*) returns a row"
  ).n;

const storedCounter = async (credentialId: string) =>
  required(
    await env.DB.prepare(
      "SELECT counter FROM passkey_credentials WHERE credential_id = ?"
    )
      .bind(credentialId)
      .first<{ counter: number }>(),
    `passkey ${credentialId} is stored`
  ).counter;

async function bootstrap(passkey: Passkey, tamper?: Tamper) {
  const started = await post("/api/auth/bootstrap/options", {
    name: "Admin",
    email: "admin@example.test",
  });

  expect(started.status).toBe(200);

  const { options, challengeId } = bootstrapStart.parse(await started.json());

  const response = await post("/api/auth/bootstrap/verify", {
    challengeId,
    response: await passkey.register(options, origin, tamper),
  });

  return { response, options };
}

async function signIn(passkey: Passkey, tamper?: Tamper, reuse?: LoginStart) {
  let started = reuse;

  if (!started) {
    const response = await post("/api/auth/login/options", {});
    expect(response.status).toBe(200);
    started = loginStart.parse(await response.json());
  }

  const response = await post("/api/auth/login/verify", {
    challengeId: started.challengeId,
    response: await passkey.authenticate(started.options, origin, tamper),
  });

  return { response, started };
}

async function expectRefused(response: Response) {
  expect(response.status).toBe(400);
  expect(response.headers.get("set-cookie")).toBeNull();
  await response.body?.cancel();
}

const passkey = await softwarePasskey();

describe("passkey registration", () => {
  const refusals: [string, Tamper][] = [
    ["another origin", { origin: "https://evil.example" }],
    ["another RP ID", { rpId: "evil.example" }],
    ["another challenge", { challenge: "bm90LXRoZS1jaGFsbGVuZ2U" }],
    ["no user verification", { flags: UP }],
  ];

  for (const [name, tamper] of refusals) {
    it(`refuses ${name}`, async () => {
      const { response } = await bootstrap(await softwarePasskey(), tamper);
      await expectRefused(response);
      expect(await count("users")).toBe(0);
      expect(await count("passkey_credentials")).toBe(0);
    });
  }

  it("asks for a resident key and user verification, and stores the verified passkey", async () => {
    const { response, options } = await bootstrap(passkey);
    expect(options.authenticatorSelection?.userVerification).toBe("required");
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("=");
    await response.body?.cancel();
    expect(await count("passkey_credentials")).toBe(1);
    expect(await storedCounter(passkey.id)).toBe(0);
  });
});

describe("passkey sign-in", () => {
  it("signs in with the registered passkey and records its counter", async () => {
    const { response, started } = await signIn(passkey);
    expect(started.options.userVerification).toBe("required");
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("=");
    await response.body?.cancel();
    expect(await storedCounter(passkey.id)).toBe(1);
  });

  const refusals: [string, Tamper][] = [
    ["another origin", { origin: "https://evil.example" }],
    ["another RP ID", { rpId: "evil.example" }],
    ["another challenge", { challenge: "bm90LXRoZS1jaGFsbGVuZ2U" }],
    ["no user verification", { flags: UP }],
    ["a signature from another key", { wrongKey: true }],
    ["a counter that did not move forward", { counter: 1 }],
    ["a counter that went back", { counter: 0 }],
  ];

  for (const [name, tamper] of refusals) {
    it(`refuses ${name}`, async () => {
      await expectRefused((await signIn(passkey, tamper)).response);
      expect(await storedCounter(passkey.id)).toBe(1);
    });
  }

  it("refuses a challenge that was already used", async () => {
    const first = await signIn(passkey);
    expect(first.response.status).toBe(200);
    await first.response.body?.cancel();
    await expectRefused((await signIn(passkey, {}, first.started)).response);
  });

  it("refuses a passkey the workspace does not know", async () => {
    await expectRefused((await signIn(await softwarePasskey())).response);
  });
});
