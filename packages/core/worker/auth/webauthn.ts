import type {
  AuthenticationResponseJSON,
  AuthenticatorTransport,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { z } from "zod";

import type { AccessLinkKind } from "../../shared/auth";
import type { Database } from "../db/client";
import type { ChallengePayload } from "../db/json";
import { authChallenges, passkeyCredentials, users } from "../db/schema";
import { base64UrlToBytes, bytesToBase64Url } from "../lib/crypto";
import { getRelyingParty } from "../lib/http";
import type { RelyingPartyEnv } from "../lib/http";
import { createId } from "../lib/ids";
import { CHALLENGE_TTL_MS } from "./constants";
import { AuthRequestError } from "./errors";

/** Loaded on first use: only passkey sign-in and registration need it. */
const webauthn = () => import("@simplewebauthn/server");

type ChallengeKind = "bootstrap" | AccessLinkKind | "authentication";

const transportSchema = z.enum([
  "ble",
  "hybrid",
  "internal",
  "nfc",
  "usb",
]) satisfies z.ZodType<AuthenticatorTransport>;

/** A passkey's saved transports that WebAuthn knows; a newer browser may send others. */
function knownTransports(saved: string[] | null) {
  return saved?.flatMap((transport) => {
    const known = transportSchema.safeParse(transport);

    return known.success ? [known.data] : [];
  });
}

export function deleteExpiredChallenges(db: Database, now = new Date()) {
  return db.delete(authChallenges).where(lte(authChallenges.expiresAt, now));
}

async function saveChallenge(
  db: Database,
  env: RelyingPartyEnv,
  input: {
    challenge: string;
    kind: ChallengeKind;
    userId?: string;
    accessLinkId?: string;
    payload?: ChallengePayload;
  }
) {
  const id = createId("chl");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  const { origin, rpId } = getRelyingParty(env);
  await deleteExpiredChallenges(db, now);
  await db.insert(authChallenges).values({
    id,
    challenge: input.challenge,
    kind: input.kind,
    // Bootstrap allocates a user id before the users row exists; D1 enforces the
    // FK, so keep the column null and carry the id in payload instead.
    userId: input.kind === "bootstrap" ? undefined : input.userId,
    accessLinkId: input.accessLinkId,
    payload: input.payload,
    rpId,
    origin,
    expiresAt,
  });

  return { id, expiresAt, origin, rpId };
}

export async function consumeChallenge(
  db: Database,
  challengeId: string | undefined,
  kind: ChallengeKind
) {
  if (!challengeId) throw new AuthRequestError("Passkey ceremony has expired");

  const [challenge] = await db
    .delete(authChallenges)
    .where(
      and(
        eq(authChallenges.id, challengeId),
        eq(authChallenges.kind, kind),
        gt(authChallenges.expiresAt, new Date())
      )
    )
    .returning();

  if (!challenge) {
    // An expired or wrong-kind challenge cannot be reused and does not need to
    // remain in D1 after the failed ceremony.
    await db.delete(authChallenges).where(eq(authChallenges.id, challengeId));
    throw new AuthRequestError("Passkey ceremony has expired");
  }

  return challenge;
}

export async function beginRegistration(
  db: Database,
  env: RelyingPartyEnv,
  input: {
    kind: "bootstrap" | AccessLinkKind;
    userId: string;
    userName: string;
    userDisplayName: string;
    accessLinkId?: string;
    payload?: ChallengePayload;
  }
) {
  const { rpId } = getRelyingParty(env);

  const existing = await db
    .select({
      id: passkeyCredentials.credentialId,
      transports: passkeyCredentials.transports,
    })
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.userId, input.userId));

  const { generateRegistrationOptions } = await webauthn();

  const options = await generateRegistrationOptions({
    rpName: "OpenWorkspace",
    rpID: rpId,
    userID: new TextEncoder().encode(input.userId),
    userName: input.userName,
    userDisplayName: input.userDisplayName,
    attestationType: "none",
    supportedAlgorithmIDs: [-7, -257],
    excludeCredentials: existing.map((credential) => ({
      id: credential.id,
      transports: knownTransports(credential.transports),
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });

  const saved = await saveChallenge(db, env, {
    challenge: options.challenge,
    kind: input.kind,
    userId: input.userId,
    accessLinkId: input.accessLinkId,
    payload: input.payload,
  });

  return { options, challenge: saved };
}

export async function finishRegistration(
  challenge: typeof authChallenges.$inferSelect,
  response: RegistrationResponseJSON
) {
  const { verifyRegistrationResponse } = await webauthn();
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;

  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
  } catch (error) {
    throw new AuthRequestError("Passkey could not be verified", {
      cause: error,
    });
  }

  if (!verification.verified) {
    throw new AuthRequestError("Passkey could not be verified");
  }

  const { credential } = verification.registrationInfo;

  return {
    credentialId: credential.id,
    publicKey: bytesToBase64Url(credential.publicKey),
    counter: credential.counter,
    transports:
      credential.transports ?? response.response.transports ?? undefined,
    deviceType: verification.registrationInfo.credentialDeviceType,
    backedUp: verification.registrationInfo.credentialBackedUp,
  };
}

export async function beginAuthentication(
  db: Database,
  env: RelyingPartyEnv,
  payload?: ChallengePayload
) {
  const { rpId } = getRelyingParty(env);
  const { generateAuthenticationOptions } = await webauthn();

  const options = await generateAuthenticationOptions({
    rpID: rpId,
    userVerification: "required",
  });

  const saved = await saveChallenge(db, env, {
    challenge: options.challenge,
    kind: "authentication",
    payload,
  });

  return { options, challenge: saved };
}

export async function finishAuthentication(
  db: Database,
  challenge: typeof authChallenges.$inferSelect,
  response: AuthenticationResponseJSON
) {
  const [stored] = await db
    .select({
      credentialId: passkeyCredentials.credentialId,
      userId: passkeyCredentials.userId,
      publicKey: passkeyCredentials.publicKey,
      counter: passkeyCredentials.counter,
      transports: passkeyCredentials.transports,
    })
    .from(passkeyCredentials)
    .innerJoin(users, eq(passkeyCredentials.userId, users.id))
    .where(
      and(
        eq(passkeyCredentials.credentialId, response.id),
        eq(users.status, "active")
      )
    )
    .limit(1);

  if (!stored) {
    throw new AuthRequestError(
      "This passkey is unavailable or the account is disabled"
    );
  }

  const credential = {
    id: stored.credentialId,
    publicKey: new Uint8Array(base64UrlToBytes(stored.publicKey)),
    counter: stored.counter,
    transports: knownTransports(stored.transports),
  };

  const { verifyAuthenticationResponse } = await webauthn();
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;

  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rpId,
      requireUserVerification: true,
      credential,
    });
  } catch (error) {
    throw new AuthRequestError("Passkey could not be verified", {
      cause: error,
    });
  }

  if (!verification.verified) {
    throw new AuthRequestError("Passkey could not be verified");
  }

  await recordPasskeyUse(
    db,
    stored.credentialId,
    verification.authenticationInfo.newCounter
  );

  return stored.userId;
}

export function recordPasskeyUse(
  db: Database,
  credentialId: string,
  newCounter: number,
  now = new Date()
) {
  return db
    .update(passkeyCredentials)
    .set({
      counter: sql<number>`max(${passkeyCredentials.counter}, ${newCounter})`,
      lastUsedAt: now,
    })
    .where(eq(passkeyCredentials.credentialId, credentialId));
}
