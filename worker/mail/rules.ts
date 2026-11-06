import { z } from "zod";
import { emailSchema } from "../auth/schemas";
import type { Email } from "../mailbox/schema";

/**
 * Mailbox rules. Conditions only use fields stored with every message, so
 * "test against existing mail" evaluates exactly what delivery evaluates.
 */

const text = z.string().trim().min(1).max(320);

export const ruleConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("from"), op: z.enum(["contains", "equals", "domain"]), value: text }),
  z.object({ type: z.literal("recipient"), op: z.enum(["contains", "equals"]), value: text }),
  z.object({ type: z.literal("subject"), op: z.enum(["contains", "equals"]), value: text }),
  z.object({ type: z.literal("listId"), op: z.enum(["exists", "contains"]), value: text.optional() }),
  z.object({ type: z.literal("hasAttachment") }),
]);

export const MAX_FORWARD_HOPS = 3;
export const FORWARD_HOP_HEADER = "X-OpenWorkspace-Forwarded";

export const ruleActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("moveToFolder"), folderId: z.string().min(1).max(80) }),
  z.object({ type: z.literal("archive") }),
  z.object({ type: z.literal("trash") }),
  z.object({ type: z.literal("spam") }),
  z.object({ type: z.literal("notSpam") }),
  z.object({ type: z.literal("markRead") }),
  z.object({
    type: z.literal("forward"),
    to: emailSchema,
    /** false = forward only: the original goes to Trash. */
    keepCopy: z.boolean().default(true),
  }),
]);

export const ruleInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(ruleConditionSchema).min(1).max(10),
  actions: z.array(ruleActionSchema).min(1).max(10)
    .refine(
      (actions) => actions.filter((action) => action.type === "forward").length <= 3,
      "A rule can forward to at most 3 addresses",
    )
    .refine(
      (actions) => new Set(actions.map((action) => action.type === "forward" ? `forward:${action.to}` : action.type)).size === actions.length,
      "Each action can appear once",
    ),
  stopProcessing: z.boolean().default(false),
});

export type RuleCondition = z.infer<typeof ruleConditionSchema>;
export type RuleAction = z.infer<typeof ruleActionSchema>;
export type RuleInput = z.infer<typeof ruleInputSchema>;

export type RuleSubject = Pick<
  Email,
  "fromJson" | "toJson" | "ccJson" | "subject" | "listId" | "attachmentsJson"
>;

const lower = (value: string) => value.toLocaleLowerCase("en-US");

function textMatches(op: "contains" | "equals", actual: string, expected: string) {
  return op === "equals" ? lower(actual) === lower(expected) : lower(actual).includes(lower(expected));
}

export function conditionMatches(condition: RuleCondition, email: RuleSubject) {
  switch (condition.type) {
    case "from": {
      const senders = email.fromJson.map((item) => item.address);
      if (condition.op === "domain") {
        const domain = lower(condition.value.replace(/^@/u, ""));
        return senders.some((address) => {
          const host = lower(address.split("@").at(-1) ?? "");
          return host === domain || host.endsWith(`.${domain}`);
        });
      }
      return senders.some((address) => textMatches(condition.op as "contains" | "equals", address, condition.value));
    }
    case "recipient":
      return [...email.toJson, ...email.ccJson]
        .some((item) => textMatches(condition.op, item.address, condition.value));
    case "subject":
      return textMatches(condition.op, email.subject, condition.value);
    case "listId":
      return condition.op === "exists"
        ? Boolean(email.listId)
        : Boolean(email.listId && condition.value && lower(email.listId).includes(lower(condition.value)));
    case "hasAttachment":
      return email.attachmentsJson.some((file) => file.disposition === "attachment");
  }
}

export function ruleMatches(
  rule: { match: "all" | "any"; conditions: RuleCondition[] },
  email: RuleSubject,
) {
  return rule.match === "all"
    ? rule.conditions.every((condition) => conditionMatches(condition, email))
    : rule.conditions.some((condition) => conditionMatches(condition, email));
}

export type RuleOutcome = {
  mailboxState: "active" | "archive" | "trash" | "spam" | null;
  folderId: string | null;
  markRead: boolean;
  forwards: Array<{ to: string; keepCopy: boolean }>;
  matchedRuleIds: string[];
};

/**
 * Applies enabled rules in order. Later actions override earlier ones for the
 * same property; "notSpam" rescues a message the AI classifier marked as spam.
 */
export function evaluateRules(
  rules: Array<RuleInput & { id: string }>,
  email: RuleSubject,
  currentState: "active" | "archive" | "trash" | "spam",
): RuleOutcome {
  const outcome: RuleOutcome = {
    mailboxState: null,
    folderId: null,
    markRead: false,
    forwards: [],
    matchedRuleIds: [],
  };
  for (const rule of rules) {
    if (!rule.enabled || !ruleMatches(rule, email)) continue;
    outcome.matchedRuleIds.push(rule.id);
    for (const action of rule.actions) {
      switch (action.type) {
        case "moveToFolder":
          outcome.mailboxState = "active";
          outcome.folderId = action.folderId;
          break;
        case "archive":
        case "trash":
        case "spam":
          outcome.mailboxState = action.type;
          outcome.folderId = null;
          break;
        case "notSpam":
          if ((outcome.mailboxState ?? currentState) === "spam") outcome.mailboxState = "active";
          break;
        case "markRead":
          outcome.markRead = true;
          break;
        case "forward":
          if (!outcome.forwards.some((forward) => forward.to === action.to)) {
            outcome.forwards.push({ to: action.to, keepCopy: action.keepCopy });
          }
          break;
      }
    }
    if (rule.stopProcessing) break;
  }
  return outcome;
}

/** Hop count carried by mail this install forwarded before. */
export function forwardHops(rawHeaderBlock: string) {
  const match = rawHeaderBlock.match(new RegExp(`^${FORWARD_HOP_HEADER}:\\s*(\\d+)`, "imu"));
  return match ? Number(match[1]) : 0;
}

/** The raw header block, unfolded; bodies are never decoded. */
export function headerBlock(raw: ArrayBuffer) {
  const text = new TextDecoder("latin1").decode(raw.slice(0, 64 * 1024));
  const end = text.search(/\r?\n\r?\n/u);
  return (end < 0 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/gu, " ");
}
