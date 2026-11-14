import type { MailboxState } from "./folder-model";

export type RetentionFolder = "trash" | "spam";

const DAY_MS = 24 * 60 * 60 * 1000;

export function isRetentionFolder(
  state: string | null | undefined
): state is RetentionFolder {
  return state === "trash" || state === "spam";
}

/** Days from `Email({ retention })` (alchemy/index.ts); null keeps mail until emptied. */
export function retentionDays(
  env: Pick<Env, "TRASH_RETENTION_DAYS" | "SPAM_RETENTION_DAYS">
): Record<RetentionFolder, number | null> {
  return {
    trash: Number(env.TRASH_RETENTION_DAYS) || null,
    spam: Number(env.SPAM_RETENTION_DAYS) || null,
  };
}

/** The folders that delete mail, with how long it stays in milliseconds. */
export function retentionRules(
  env: Pick<Env, "TRASH_RETENTION_DAYS" | "SPAM_RETENTION_DAYS">
) {
  const days = retentionDays(env);

  return (["trash", "spam"] as const satisfies MailboxState[]).flatMap(
    (state) => {
      const limit = days[state];

      return limit ? [{ state, ms: limit * DAY_MS }] : [];
    }
  );
}
