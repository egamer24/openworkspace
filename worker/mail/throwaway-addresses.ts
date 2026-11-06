import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { createDb } from "../db/client";
import { mailboxAddress } from "../db/mailboxes";
import { domains, mailboxes, routingAddresses } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { createId } from "../lib/ids";
import { getMailboxAccess } from "./access";

const ADJECTIVES = [
  "amber", "brave", "bright", "calm", "clever", "cosmic", "crisp", "dapper", "eager", "fancy",
  "fluffy", "gentle", "glad", "golden", "grand", "happy", "hazy", "humble", "jolly", "keen",
  "kind", "lively", "lucky", "mellow", "merry", "mighty", "misty", "modest", "neat", "nimble",
  "noble", "olive", "plain", "plucky", "polite", "proud", "quick", "quiet", "rapid", "rosy",
  "royal", "rustic", "shiny", "silent", "silver", "simple", "sleepy", "smooth", "snowy", "sober",
  "solid", "spicy", "steady", "sunny", "swift", "tidy", "tiny", "upbeat", "vivid", "warm",
  "wise", "witty", "young", "zesty",
] as const;

const NOUNS = [
  "acorn", "badger", "beacon", "birch", "bison", "breeze", "brook", "canyon", "cedar", "comet",
  "coral", "cricket", "delta", "dune", "falcon", "fern", "finch", "fjord", "garnet", "gecko",
  "glacier", "harbor", "hazel", "heron", "island", "jasper", "kettle", "lagoon", "lantern", "lark",
  "lemur", "maple", "meadow", "meteor", "moose", "nectar", "otter", "panda", "pebble", "pepper",
  "pine", "plover", "puffin", "quartz", "raven", "reef", "ridge", "river", "robin", "saffron",
  "sparrow", "spruce", "summit", "thistle", "tiger", "tulip", "valley", "walnut", "willow", "wren",
  "yak", "zebra", "orbit", "violet",
] as const;

/** Throwaways each person may hold; turned-off ones still count. */
export const MAX_THROWAWAYS_PER_USER = 200;

function randomInt(max: number) {
  // ponytail: modulo bias is negligible for these list sizes (< 2^-20).
  return crypto.getRandomValues(new Uint32Array(1))[0]! % max;
}

/** Random `adjective-noun-1234` local part: about 37 million combinations. */
export function throwawayLocalPart() {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const noun = NOUNS[randomInt(NOUNS.length)];
  return `${adjective}-${noun}-${1000 + randomInt(9000)}`;
}

const label = z.string().trim().max(80).transform((value) => value || null);

const createThrowawaySchema = z.object({
  mailboxId: z.string().min(1),
  label: label.nullable().default(null),
});

const updateThrowawaySchema = z.object({
  enabled: z.boolean().optional(),
  label: label.nullable().optional(),
}).refine((value) => value.enabled !== undefined || value.label !== undefined, {
  message: "Nothing to update",
});

function throwawayView(row: {
  id: string;
  localPart: string;
  domain: string;
  label: string | null;
  mailboxId: string | null;
  disabledAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    address: mailboxAddress(row.localPart, row.domain),
    label: row.label,
    mailboxId: row.mailboxId,
    enabled: row.disabledAt === null,
    createdAt: row.createdAt,
  };
}

const throwawayColumns = {
  id: routingAddresses.id,
  localPart: routingAddresses.localPart,
  domain: domains.name,
  label: routingAddresses.label,
  mailboxId: routingAddresses.mailboxId,
  disabledAt: routingAddresses.disabledAt,
  createdAt: routingAddresses.createdAt,
};

function ownThrowaway(userId: string, id?: string) {
  return and(
    eq(routingAddresses.createdByUserId, userId),
    eq(routingAddresses.throwaway, true),
    ...(id ? [eq(routingAddresses.id, id)] : []),
  );
}

/**
 * Receive-only addresses people generate for themselves. Each is a routing
 * address flagged `throwaway` that delivers into a mailbox its creator can
 * send from; turning it off makes inbound routing reject it.
 */
export const throwawayRoutes = new Hono<AppEnv>()
  .get("/", requireAuth, async (c) => {
    const rows = await createDb(c.env.DB)
      .select(throwawayColumns)
      .from(routingAddresses)
      .innerJoin(domains, eq(routingAddresses.domainId, domains.id))
      .where(ownThrowaway(c.get("user").id))
      .orderBy(desc(routingAddresses.createdAt));
    return c.json({
      ok: true as const,
      limit: MAX_THROWAWAYS_PER_USER,
      addresses: rows.map(throwawayView),
    });
  })
  .post("/", requireAuth, zValidator("json", createThrowawaySchema), async (c) => {
    const userId = c.get("user").id;
    const input = c.req.valid("json");
    const db = createDb(c.env.DB);
    const access = await getMailboxAccess(db, userId, input.mailboxId);
    if (!access?.canSend) {
      return apiError(c, 403, "FORBIDDEN", "Send access to the mailbox is required");
    }
    const [{ total }] = await db
      .select({ total: count() })
      .from(routingAddresses)
      .where(ownThrowaway(userId)) as [{ total: number }];
    if (total >= MAX_THROWAWAYS_PER_USER) {
      return apiError(c, 409, "CONFLICT", `You can have at most ${MAX_THROWAWAYS_PER_USER} throwaway addresses`);
    }
    const [mailbox] = await db
      .select({ domainId: mailboxes.domainId, domain: domains.name })
      .from(mailboxes)
      .innerJoin(domains, eq(mailboxes.domainId, domains.id))
      .where(eq(mailboxes.id, input.mailboxId))
      .limit(1);
    if (!mailbox) return apiError(c, 404, "NOT_FOUND", "Mailbox not found");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const localPart = throwawayLocalPart();
      const [taken] = await db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(and(eq(mailboxes.domainId, mailbox.domainId), eq(mailboxes.localPart, localPart)))
        .limit(1);
      if (taken) continue;
      const id = createId("rta");
      const now = new Date();
      try {
        await db.insert(routingAddresses).values({
          id,
          domainId: mailbox.domainId,
          localPart,
          mailboxId: input.mailboxId,
          keepCopy: true,
          createdByUserId: userId,
          throwaway: true,
          label: input.label,
          createdAt: now,
          updatedAt: now,
        });
      } catch {
        continue; // Unique address index: another route already uses it.
      }
      return c.json({
        ok: true as const,
        address: throwawayView({
          id,
          localPart,
          domain: mailbox.domain,
          label: input.label,
          mailboxId: input.mailboxId,
          disabledAt: null,
          createdAt: now,
        }),
      }, 201);
    }
    return apiError(c, 409, "CONFLICT", "Could not find a free address; try again");
  })
  .patch("/:id", requireAuth, zValidator("json", updateThrowawaySchema), async (c) => {
    const input = c.req.valid("json");
    const now = new Date();
    const db = createDb(c.env.DB);
    const [updated] = await db
      .update(routingAddresses)
      .set({
        ...(input.enabled === undefined ? {} : { disabledAt: input.enabled ? null : now }),
        ...(input.label === undefined ? {} : { label: input.label }),
        updatedAt: now,
      })
      .where(ownThrowaway(c.get("user").id, c.req.param("id")))
      .returning({ id: routingAddresses.id });
    if (!updated) return apiError(c, 404, "NOT_FOUND", "Throwaway address not found");
    const [row] = await db
      .select(throwawayColumns)
      .from(routingAddresses)
      .innerJoin(domains, eq(routingAddresses.domainId, domains.id))
      .where(eq(routingAddresses.id, updated.id));
    return c.json({ ok: true as const, address: throwawayView(row!) });
  });
