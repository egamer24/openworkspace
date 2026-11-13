import type { InboundAuthentication } from "../../shared/mail-authentication";
import type { SenderIntel } from "../../shared/mail-sender-intel";
import type { mailboxStub } from "../mailbox";
import type { Email } from "../mailbox/schema";
import { linkDomains } from "./link-domains";
import {
  collectSenderIntel,
  senderIntelWorthStoring,
  storedSenderIntel,
} from "./sender-intel";

export function headerAuthentication(
  email: Email
): InboundAuthentication | null {
  const stored = email.authenticationResultsJson;

  return stored?.version === 1 ? stored : null;
}

/**
 * A view retries lookups that all failed only after this long. The failed
 * result is stored (and shown) meanwhile, so opening the message again does
 * not wait on DNS that just failed.
 */
export const SENDER_INTEL_RETRY_MS = 60 * 60 * 1000;

/**
 * Whether a received message still needs sender intelligence: ingestion
 * stores none when every lookup failed, and a stored failure is retried once
 * it is older than `SENDER_INTEL_RETRY_MS`.
 */
export function senderIntelPending(email: Email, now = Date.now()) {
  if (email.direction !== "incoming" || !headerAuthentication(email)) {
    return false;
  }

  const stored = storedSenderIntel(email.senderIntelJson);

  if (!stored) return true;

  return (
    stored.source === "live" &&
    !senderIntelWorthStoring(stored) &&
    now - stored.checkedAt >= SENDER_INTEL_RETRY_MS
  );
}

type SenderIntelContext = {
  bodyHtml: string | null;
  workspaceDomains: readonly string[];
  dqsKey: string | null;
};

// One lookup per message at a time in this isolate: the reader's background
// fill and its follow-up request share it.
const inFlight = new Map<string, Promise<SenderIntel>>();

/**
 * Looks up and stores sender intelligence for a message that needs it (see
 * `senderIntelPending`); a result where every lookup failed is stored too,
 * so it is retried only after `SENDER_INTEL_RETRY_MS`. Returns the message
 * with the intelligence it now has.
 */
export async function withSenderIntel(
  env: Env,
  mailbox: ReturnType<typeof mailboxStub>,
  email: Email,
  context: SenderIntelContext
): Promise<Email> {
  if (!senderIntelPending(email)) return email;
  const key = `${mailbox.id.toString()}:${email.id}`;
  let work = inFlight.get(key);

  if (!work) {
    const previous =
      storedSenderIntel(email.senderIntelJson)?.checkedAt ?? null;

    work = (async () => {
      const intel = await collectSenderIntel({
        authentication: headerAuthentication(email),
        fromAddress: email.fromJson[0]?.address ?? "",
        linkDomains: linkDomains({
          html: context.bodyHtml,
          text: [email.bodyText, email.quotedText],
          workspaceDomains: context.workspaceDomains,
        }),
        workspaceDomains: context.workspaceDomains,
        dqsKey: context.dqsKey,
        bucket: env.MAIL_STORAGE,
      });

      await mailbox.setEmailSenderIntel(email.id, intel, previous);

      return intel;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, work);
  }

  try {
    return { ...email, senderIntelJson: await work };
  } catch (error) {
    console.error(
      `Could not collect sender intelligence for ${email.id}`,
      error
    );

    return email;
  }
}
