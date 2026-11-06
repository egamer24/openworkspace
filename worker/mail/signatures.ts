import { and, eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { mailboxSignatures } from "../db/schema";
import { escapeHtml } from "./outbound-content";

/** Appends the sender's plain-text signature when an API or MCP caller asks for it. */
export async function withSignature<
  T extends { bodyText: string; bodyHtml?: string; includeSignature?: boolean },
>(env: Env, userId: string, mailboxId: string, input: T): Promise<T> {
  if (!input.includeSignature) return input;
  const [signature] = await createDb(env.DB)
    .select({ text: mailboxSignatures.text })
    .from(mailboxSignatures)
    .where(and(
      eq(mailboxSignatures.mailboxId, mailboxId),
      eq(mailboxSignatures.userId, userId),
    ))
    .limit(1);
  if (!signature?.text) return input;
  return {
    ...input,
    bodyText: input.bodyText.trim()
      ? `${input.bodyText.trimEnd()}\n\n${signature.text}`
      : signature.text,
    bodyHtml: input.bodyHtml === undefined
      ? undefined
      : `${input.bodyHtml}<p>${escapeHtml(signature.text).replaceAll("\n", "<br>")}</p>`,
  };
}
