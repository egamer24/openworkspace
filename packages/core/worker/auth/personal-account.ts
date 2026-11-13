import { sql } from "drizzle-orm";

import type { Database } from "../db/client";
import { mailboxes, passkeyCredentials, teams, users } from "../db/schema";
import { mailboxAddressParts } from "../lib/ids";

type PersonalAccountInput = {
  userId: string;
  mailboxId: string;
  name: string;
  email: string;
  role: "admin" | "member";
  status: "invited" | "active";
  createdByUserId: string;
  now: Date;
};

/** The user and personal mailbox rows; the caller has checked `mailDomainAllowed(email)`. */
export function personalAccountRecords(input: PersonalAccountInput) {
  const address = mailboxAddressParts(input.email);

  return {
    user: {
      id: input.userId,
      name: input.name,
      role: input.role,
      status: input.status,
      createdAt: input.now,
      updatedAt: input.now,
    },
    mailbox: {
      id: input.mailboxId,
      localPart: address.localPart,
      domain: address.domain,
      displayName: input.name,
      ownerUserId: input.userId,
      isPrimary: true,
      createdByUserId: input.createdByUserId,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

/**
 * Creates the first administrator, their personal mailbox and the
 * Everyone team, in one D1 batch. The user row goes in only while there are
 * no users at all, in the same statement; everything after it references
 * that row, so when another setup won the race the batch fails as a whole
 * and nothing is left behind. Throws `FirstAccountTakenError` then.
 */
export async function provisionBootstrapAccount(
  db: Database,
  input: PersonalAccountInput & {
    credential?: typeof passkeyCredentials.$inferInsert;
  }
) {
  const account = personalAccountRecords(input);
  const { user } = account;

  const firstUser = db
    .insert(users)
    .select(sql`
    SELECT ${user.id}, ${user.name}, NULL, ${user.role}, ${user.status}, '[]',
      ${user.createdAt.getTime()}, ${user.updatedAt.getTime()}
    WHERE NOT EXISTS (SELECT 1 FROM ${users})
  `)
    .returning({ id: users.id });

  const rest = [
    db.insert(mailboxes).values(account.mailbox),
    // Everyone active belongs to this team; it feeds an all@ list and SSO groups.
    db
      .insert(teams)
      .values({
        id: "team_everyone",
        name: "Everyone",
        slug: "everyone",
        description: "Everyone active in the workspace",
        everyone: true,
        createdByUserId: input.userId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing(),
    ...(input.credential
      ? [db.insert(passkeyCredentials).values(input.credential)]
      : []),
  ] as const;

  let inserted: { id: string }[];

  try {
    [inserted] = await db.batch([firstUser, ...rest]);
  } catch (error) {
    // The rows after the user reference it: without it, the batch fails.
    const [existing] = await db.select({ id: users.id }).from(users).limit(1);

    if (existing) throw new FirstAccountTakenError();
    throw error;
  }

  if (inserted.length !== 1) throw new FirstAccountTakenError();

  return account;
}

/** Someone else became the first administrator first. */
export class FirstAccountTakenError extends Error {
  constructor() {
    super("Account is already set up");
  }
}
