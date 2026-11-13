/**
 * The data types JMAP pushes for a mailbox account, apart from push.ts so
 * the event stream does not load the Web Push sender.
 */

/** Data types whose state a mailbox account reports; one state covers them all. */
export const JMAP_PUSH_TYPES = [
  "Email",
  "Mailbox",
  "Thread",
  "EmailDelivery",
] as const;

type JmapPushType = (typeof JMAP_PUSH_TYPES)[number];

/** RFC 8620 §7.1: what changed, per account and data type. */
export type StateChange = {
  "@type": "StateChange";
  changed: Record<string, Record<JmapPushType, string>>;
};

const pushTypeNames: ReadonlySet<string> = new Set(JMAP_PUSH_TYPES);

/** Whether a client that asked for `types` (null: all) wants mail changes. */
export function wantsMailChanges(types: readonly string[] | null) {
  return !types || types.some((type) => pushTypeNames.has(type));
}
