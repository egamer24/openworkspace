import { and, asc, eq, isNotNull, notInArray } from "drizzle-orm";

import { declaredWebhooksSchema } from "../../shared/webhook-declarations";
import { createDb } from "../db/client";
import { settings, users, webhookEndpoints } from "../db/schema";
import { hashToken } from "../lib/crypto";
import { workspaceWebhookEvents } from "../modules";

/** Hash of the declarations last applied, so isolates skip the writes. */
const APPLIED_KEY = "webhook_declarations_applied";

let applied: string | undefined;
let running: Promise<void> | undefined;

/**
 * Keeps the webhook endpoints declared in alchemy.run.ts (the
 * DECLARED_WEBHOOKS secret) in D1, removing declared ones taken out. Runs
 * before events are dispatched, on the admin pages, and hourly.
 */
export async function syncDeclaredWebhooks(env: Env) {
  const source = env.DECLARED_WEBHOOKS ?? "[]";

  if (applied === source) return;
  // A failure leaves the endpoints as they were; the next caller retries.
  running ??= applyDeclarations(env, source)
    .catch((error) => console.error("Could not apply declared webhooks", error))
    .finally(() => {
      running = undefined;
    });
  await running;
}

/** Forgets what this isolate applied; for tests that change DECLARED_WEBHOOKS. */
export function resetDeclaredWebhooks() {
  applied = undefined;
  running = undefined;
}

async function applyDeclarations(env: Env, source: string) {
  const db = createDb(env.DB);
  const fingerprint = await hashToken(source);

  const [stored] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, APPLIED_KEY));

  if (stored?.value === fingerprint) {
    applied = source;

    return;
  }

  const webhooks = declaredWebhooksSchema.parse(JSON.parse(source));
  const known = workspaceWebhookEvents();

  for (const webhook of webhooks) {
    const unknown = webhook.events.filter((event) => !(event in known));

    if (unknown.length) {
      throw new Error(
        `Webhook ${webhook.name} subscribes to events this workspace does not send: ${unknown.join(", ")}`
      );
    }
  }

  // Endpoints need an owner; until the first administrator exists there are no events.
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.status, "active")))
    .orderBy(asc(users.createdAt))
    .limit(1);

  if (!owner) return;
  const now = new Date();
  await db.batch([
    db.delete(webhookEndpoints).where(
      and(
        isNotNull(webhookEndpoints.managedBy),
        ...(webhooks.length
          ? [
              notInArray(
                webhookEndpoints.id,
                webhooks.map((webhook) => webhook.id)
              ),
            ]
          : [])
      )
    ),
    ...webhooks.map((webhook) => {
      const fields = {
        name: webhook.name,
        url: webhook.url,
        events: webhook.events,
        enabled: webhook.enabled,
        signingSecret: webhook.secret,
        managedBy: "deployment" as const,
        updatedAt: now,
      };

      return db
        .insert(webhookEndpoints)
        .values({
          id: webhook.id,
          ...fields,
          createdByUserId: owner.id,
          createdAt: now,
        })
        .onConflictDoUpdate({ target: webhookEndpoints.id, set: fields });
    }),
    db
      .insert(settings)
      .values({ key: APPLIED_KEY, value: fingerprint, updatedAt: now })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: fingerprint, updatedAt: now },
      }),
  ]);
  applied = source;
}
