import {
  isValidExternalEmailAddress,
  MAX_MAIL_RECIPIENTS,
  normalizeExternalEmailAddress,
} from "../../shared/mail";

export type ComposerRecipient = {
  address: string;
  name: string | null;
};

export type RecipientFieldValue = {
  recipients: ComposerRecipient[];
  input: string;
};

export const RECIPIENT_SEPARATOR = /[,;\n]/u;

export function normalizeComposerRecipient(
  recipient: ComposerRecipient
): ComposerRecipient | null {
  const address = normalizeExternalEmailAddress(recipient.address);

  if (!isValidExternalEmailAddress(address)) return null;

  return {
    address,
    name: recipient.name?.trim() || null,
  };
}

function recipientFromText(value: string): ComposerRecipient | null {
  const trimmed = value.trim();

  if (!trimmed) return null;
  const named = /^(.*?)\s*<([^<>]+)>$/u.exec(trimmed);
  const name = named?.[1]?.trim().replaceAll(/^["']|["']$/gu, "") || null;

  return normalizeComposerRecipient({
    address: named?.[2] ?? trimmed,
    name,
  });
}

function recipientParts(value: string) {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let angleDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);

    if (escaped) {
      escaped = false;
      continue;
    }

    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }

    if (character === '"') {
      quoted = !quoted;
      continue;
    }

    if (!quoted && character === "<") {
      angleDepth += 1;
      continue;
    }

    if (!quoted && character === ">" && angleDepth > 0) {
      angleDepth -= 1;
      continue;
    }

    if (
      !quoted &&
      angleDepth === 0 &&
      (character === "," || character === ";" || character === "\n")
    ) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(value.slice(start));

  return parts;
}

export function parseComposerRecipients(value: string) {
  const recipients: ComposerRecipient[] = [];
  const invalidParts: string[] = [];

  for (const part of recipientParts(value)) {
    const trimmed = part.trim();

    if (!trimmed) continue;
    const recipient = recipientFromText(trimmed);

    if (recipient) recipients.push(recipient);
    else invalidParts.push(trimmed);
  }

  return { recipients, invalidParts };
}

/** A field holding these addresses, nothing typed. */
export function recipientField(
  addresses: readonly string[]
): RecipientFieldValue {
  return {
    recipients: addresses.map((address) => ({ address, name: null })),
    input: "",
  };
}

/** The field's addresses, including what is typed but not yet a chip. */
export function recipientAddresses(value: RecipientFieldValue) {
  return recipientsWithPendingInput(value).map(
    (recipient) => recipient.address
  );
}

export function recipientsWithPendingInput(value: RecipientFieldValue) {
  const { recipients: pending } = parseComposerRecipients(value.input);
  const seen = new Set<string>();

  return [...value.recipients, ...pending].filter((recipient) => {
    const key = normalizeExternalEmailAddress(recipient.address);

    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });
}

function hasInvalidRecipientInput(value: RecipientFieldValue) {
  return parseComposerRecipients(value.input).invalidParts.length > 0;
}

export type ValidatedComposerRecipients = {
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string | undefined;
  count: number;
  error: string | null;
};

export function validateComposerRecipients(input: {
  to: RecipientFieldValue;
  cc: RecipientFieldValue;
  bcc: RecipientFieldValue;
  replyTo?: string;
}): ValidatedComposerRecipients {
  const fields = [input.to, input.cc, input.bcc] as const;

  if (fields.some(hasInvalidRecipientInput)) {
    return invalidRecipients("Check the recipient addresses");
  }

  let invalidCommittedAddress = false;
  const seen = new Set<string>();

  const take = (field: RecipientFieldValue) =>
    recipientsWithPendingInput(field).flatMap((recipient) => {
      const normalized = normalizeComposerRecipient(recipient);

      if (!normalized) {
        invalidCommittedAddress = true;

        return [];
      }

      if (seen.has(normalized.address)) return [];
      seen.add(normalized.address);

      return [normalized.address];
    });

  const to = take(input.to);
  const cc = take(input.cc);
  const bcc = take(input.bcc);

  if (invalidCommittedAddress) {
    return invalidRecipients("Check the recipient addresses");
  }

  const count = to.length + cc.length + bcc.length;

  if (count > MAX_MAIL_RECIPIENTS) {
    return invalidRecipients(
      `Use at most ${MAX_MAIL_RECIPIENTS} recipients across To, Cc, and Bcc`
    );
  }

  const rawReplyTo = input.replyTo?.trim() ?? "";

  const replyTo = rawReplyTo
    ? normalizeExternalEmailAddress(rawReplyTo)
    : undefined;

  if (replyTo && !isValidExternalEmailAddress(replyTo)) {
    return invalidRecipients("Check the Reply-to address");
  }

  return { to, cc, bcc, replyTo, count, error: null };
}

function invalidRecipients(error: string): ValidatedComposerRecipients {
  return {
    to: [],
    cc: [],
    bcc: [],
    replyTo: undefined,
    count: 0,
    error,
  };
}
