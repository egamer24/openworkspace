import { normalizeEmail } from "@open-workspace/core/module";

export type RecipientFields = {
  to: string[];
  cc: string[];
  bcc: string[];
};

/**
 * A destination can occupy only one visible/hidden role. Precedence follows
 * what recipients can observe: To, then Cc, then Bcc.
 */
export function dedupeRecipientFields(input: RecipientFields): RecipientFields {
  const seen = new Set<string>();

  const take = (values: string[]) => {
    const result: string[] = [];

    for (const value of values) {
      const normalized = normalizeEmail(value);

      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    }

    return result;
  };

  return {
    to: take(input.to),
    cc: take(input.cc),
    bcc: take(input.bcc),
  };
}

export function recipientCount(input: RecipientFields) {
  return input.to.length + input.cc.length + input.bcc.length;
}
