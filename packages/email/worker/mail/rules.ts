import { z } from "zod";

import type { Email } from "../mailbox/schema";

/**
 * Mailbox rules: deterministic conditions and actions run on live
 * deliveries. Conditions only read fields stored with every message, so
 * "test on recent mail" evaluates exactly what delivery evaluates.
 */

const text = z.string().trim().min(1).max(320);

export const ruleConditionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("from"),
    op: z.enum(["contains", "equals", "domain"]),
    value: text,
  }),
  z.object({
    type: z.literal("recipient"),
    op: z.enum(["contains", "equals"]),
    value: text,
  }),
  z.object({
    type: z.literal("subject"),
    op: z.enum(["contains", "equals"]),
    value: text,
  }),
  z.object({
    type: z.literal("listId"),
    op: z.enum(["exists", "contains"]),
    value: text.optional(),
  }),
  z.object({ type: z.literal("hasAttachment") }),
]);

export const ruleActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("moveToFolder"),
    folderId: z.string().min(1).max(200),
  }),
  z.object({ type: z.literal("archive") }),
  z.object({ type: z.literal("trash") }),
  z.object({ type: z.literal("spam") }),
  z.object({ type: z.literal("notSpam") }),
  z.object({ type: z.literal("markRead") }),
]);

export const ruleInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(ruleConditionSchema).min(1).max(10),
  actions: z
    .array(ruleActionSchema)
    .min(1)
    .max(10)
    .refine(
      (actions) =>
        new Set(actions.map((action) => action.type)).size === actions.length,
      "Each action can appear once"
    ),
  stopProcessing: z.boolean().default(false),
});

export const ruleTestSchema = ruleInputSchema.pick({
  match: true,
  conditions: true,
});

export type RuleCondition = z.infer<typeof ruleConditionSchema>;

export type RuleAction = z.infer<typeof ruleActionSchema>;

export type RuleInput = z.infer<typeof ruleInputSchema>;

export type RuleSubject = Pick<
  Email,
  | "fromJson"
  | "toJson"
  | "ccJson"
  | "envelopeTo"
  | "subject"
  | "listId"
  | "attachmentsJson"
>;

const lower = (value: string) => value.toLocaleLowerCase("en-US");

function textMatches(
  op: "contains" | "equals",
  actual: string,
  expected: string
) {
  return op === "equals"
    ? lower(actual) === lower(expected)
    : lower(actual).includes(lower(expected));
}

export function conditionMatches(condition: RuleCondition, email: RuleSubject) {
  switch (condition.type) {
    case "from": {
      const senders = email.fromJson.map((item) => item.address);
      const { op } = condition;

      if (op === "domain") {
        const domain = lower(condition.value.replace(/^@/u, ""));

        return senders.some((address) => {
          const host = lower(address.split("@").at(-1) ?? "");

          return host === domain || host.endsWith(`.${domain}`);
        });
      }

      return senders.some((address) =>
        textMatches(op, address, condition.value)
      );
    }

    // To, Cc, and the address the mail was delivered to (Bcc, forwards).
    case "recipient": {
      return [
        ...email.toJson.map((item) => item.address),
        ...email.ccJson.map((item) => item.address),
        ...(email.envelopeTo ? [email.envelopeTo] : []),
      ].some((address) => textMatches(condition.op, address, condition.value));
    }

    case "subject": {
      return textMatches(condition.op, email.subject, condition.value);
    }

    case "listId": {
      return condition.op === "exists"
        ? Boolean(email.listId)
        : Boolean(
            email.listId &&
            condition.value &&
            lower(email.listId).includes(lower(condition.value))
          );
    }

    default: {
      return email.attachmentsJson.some(
        (file) => file.disposition === "attachment"
      );
    }
  }
}

export function ruleMatches(
  rule: { match: "all" | "any"; conditions: RuleCondition[] },
  email: RuleSubject
) {
  return rule.match === "all"
    ? rule.conditions.every((condition) => conditionMatches(condition, email))
    : rule.conditions.some((condition) => conditionMatches(condition, email));
}

export type RuleOutcome = {
  /** Where the matching rules file the message; null leaves it to AI sorting. */
  placement:
    | { type: "folder"; folderId: string }
    | { type: "archive" | "trash" | "spam" }
    | null;
  /** A "never Spam" rule matched: an AI spam verdict is ignored. */
  notSpam: boolean;
  markRead: boolean;
  matchedRuleIds: string[];
};

/**
 * Applies enabled rules in order. A later placement replaces an earlier
 * one; "stop processing" ends the run after its rule.
 */
export function evaluateRules(
  rules: (RuleInput & { id: string })[],
  email: RuleSubject
): RuleOutcome {
  const outcome: RuleOutcome = {
    placement: null,
    notSpam: false,
    markRead: false,
    matchedRuleIds: [],
  };

  for (const rule of rules) {
    if (!rule.enabled || !ruleMatches(rule, email)) continue;
    outcome.matchedRuleIds.push(rule.id);

    for (const action of rule.actions) {
      switch (action.type) {
        case "moveToFolder": {
          outcome.placement = { type: "folder", folderId: action.folderId };
          break;
        }

        case "archive":
        case "trash":
        case "spam": {
          outcome.placement = { type: action.type };
          break;
        }

        case "notSpam": {
          outcome.notSpam = true;
          break;
        }

        default: {
          outcome.markRead = true;
          break;
        }
      }
    }

    if (rule.stopProcessing) break;
  }

  return outcome;
}
