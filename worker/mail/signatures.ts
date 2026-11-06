import { and, eq } from "drizzle-orm";
import { convert } from "html-to-text";
import { createDb } from "../db/client";
import { mailboxSignatures } from "../db/schema";

/** Plain-text rendering of an already sanitized signature. */
export function signatureText(html: string) {
  return convert(html, {
    wordwrap: false,
    selectors: [{ selector: "a", options: { hideLinkHrefIfSameAsText: true } }],
  }).trim();
}

/** Appends the sender's signature when an API or MCP caller asks for it. */
export async function withSignature<
  T extends { bodyText: string; bodyHtml?: string; includeSignature?: boolean },
>(env: Env, userId: string, mailboxId: string, input: T): Promise<T> {
  if (!input.includeSignature) return input;
  const [signature] = await createDb(env.DB)
    .select({ html: mailboxSignatures.html, text: mailboxSignatures.text })
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
      : `${input.bodyHtml}<div data-signature>${signature.html}</div>`,
  };
}
