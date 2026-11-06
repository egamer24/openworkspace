import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { createDb } from "../db/client";
import { mailboxAddress } from "../db/mailboxes";
import {
  domains,
  forwardingDestinations,
  mailboxes,
  routingAddressDestinations,
  routingAddresses,
} from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { createId, mailboxAddressParts, normalizeEmail } from "../lib/ids";
import {
  CloudflareApiError,
  cloudflareApiFromEnv,
  type CloudflareApi,
} from "./cloudflare-onboarding";
import { domainForAddress } from "./records";
import {
  destinationVerifiedSchema,
  forwardingDestinationSchema,
  routingAddressSchema,
  unknownRecipientSchema,
} from "./schemas";

type CloudflareDestination = { id: string; email: string; verified: string | null };

const MANUAL_DESTINATION_STEP = "Add this address in the Cloudflare dashboard under "
  + "Email Routing → Destination addresses, open the verification email Cloudflare "
  + "sends to it, then mark it verified here.";

/**
 * Finds the account-level Email Routing destination address, creating it (and
 * triggering Cloudflare's verification email) when it does not exist yet.
 * Needs the Email Routing Addresses Write permission.
 */
export async function ensureCloudflareDestination(
  api: CloudflareApi,
  accountId: string,
  email: string,
) {
  const base = `/accounts/${encodeURIComponent(accountId)}/email/routing/addresses`;
  const wanted = normalizeEmail(email).toLowerCase();
  for (let page = 1; page <= 20; page += 1) {
    const batch = await api.request<CloudflareDestination[]>(
      "GET",
      `${base}?per_page=50&page=${page}`,
    );
    const found = batch.find((item) => normalizeEmail(item.email).toLowerCase() === wanted);
    if (found) return found;
    if (batch.length < 50) break;
  }
  return api.request<CloudflareDestination>("POST", base, { email });
}

function destinationApi(env: AppEnv["Bindings"]) {
  const api = cloudflareApiFromEnv(env);
  return api && env.CLOUDFLARE_ACCOUNT_ID
    ? { api, accountId: env.CLOUDFLARE_ACCOUNT_ID }
    : null;
}

function cloudflareError(c: Context<AppEnv>, error: unknown) {
  if (!(error instanceof CloudflareApiError)) throw error;
  console.warn("Cloudflare destination request failed", error.message);
  return apiError(c, 502, "BAD_GATEWAY", error.message);
}

export const routingAdminRoutes = new Hono<AppEnv>()
  .get("/routing", async (c) => {
    const db = createDb(c.env.DB);
    const [destinationRows, addressRows, links, domainRows] = await db.batch([
      db.select().from(forwardingDestinations).orderBy(forwardingDestinations.email),
      db
        .select({
          id: routingAddresses.id,
          localPart: routingAddresses.localPart,
          domain: domains.name,
          domainId: routingAddresses.domainId,
          mailboxId: routingAddresses.mailboxId,
          keepCopy: routingAddresses.keepCopy,
          throwaway: routingAddresses.throwaway,
          label: routingAddresses.label,
          disabledAt: routingAddresses.disabledAt,
        })
        .from(routingAddresses)
        .innerJoin(domains, eq(routingAddresses.domainId, domains.id))
        .orderBy(domains.name, routingAddresses.localPart),
      db.select().from(routingAddressDestinations),
      db
        .select({
          id: domains.id,
          name: domains.name,
          unknownRecipientMailboxId: domains.unknownRecipientMailboxId,
        })
        .from(domains)
        .orderBy(domains.name),
    ]);
    return c.json({
      ok: true as const,
      cloudflareConfigured: destinationApi(c.env) !== null,
      manualDestinationStep: MANUAL_DESTINATION_STEP,
      destinations: destinationRows.map((row) => ({
        id: row.id,
        email: row.email,
        verified: row.verifiedAt !== null,
        verifiedAt: row.verifiedAt,
        createdAt: row.createdAt,
      })),
      addresses: addressRows.map(({ localPart, domain, disabledAt, ...row }) => ({
        ...row,
        enabled: disabledAt === null,
        address: mailboxAddress(localPart, domain),
        destinationIds: links
          .filter((link) => link.addressId === row.id)
          .map((link) => link.destinationId),
      })),
      domains: domainRows,
    });
  })
  .post(
    "/routing/destinations",
    zValidator("json", forwardingDestinationSchema),
    async (c) => {
      const db = createDb(c.env.DB);
      const { email } = c.req.valid("json");
      const remote = destinationApi(c.env);
      let created: CloudflareDestination | null = null;
      if (remote) {
        try {
          created = await ensureCloudflareDestination(remote.api, remote.accountId, email);
        } catch (error) {
          return cloudflareError(c, error);
        }
      }
      const id = createId("dst");
      try {
        await db.insert(forwardingDestinations).values({
          id,
          email,
          cloudflareId: created?.id ?? null,
          verifiedAt: created?.verified ? new Date(created.verified) : null,
        });
      } catch {
        return apiError(c, 409, "CONFLICT", "Destination is already added");
      }
      return c.json({
        ok: true as const,
        destinationId: id,
        verified: Boolean(created?.verified),
        manualStep: remote ? null : MANUAL_DESTINATION_STEP,
      }, 201);
    },
  )
  .post("/routing/destinations/:id/refresh", async (c) => {
    const db = createDb(c.env.DB);
    const id = c.req.param("id");
    const [destination] = await db
      .select({ email: forwardingDestinations.email })
      .from(forwardingDestinations)
      .where(eq(forwardingDestinations.id, id))
      .limit(1);
    if (!destination) return apiError(c, 404, "NOT_FOUND", "Destination not found");
    const remote = destinationApi(c.env);
    if (!remote) {
      return apiError(c, 503, "UNAVAILABLE", "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not configured");
    }
    try {
      const current = await ensureCloudflareDestination(
        remote.api,
        remote.accountId,
        destination.email,
      );
      await db
        .update(forwardingDestinations)
        .set({
          cloudflareId: current.id,
          verifiedAt: current.verified ? new Date(current.verified) : null,
          updatedAt: new Date(),
        })
        .where(eq(forwardingDestinations.id, id));
      return c.json({ ok: true as const, verified: Boolean(current.verified) });
    } catch (error) {
      return cloudflareError(c, error);
    }
  })
  .patch(
    "/routing/destinations/:id",
    zValidator("json", destinationVerifiedSchema),
    async (c) => {
      // With API access Cloudflare is the source of truth; refresh instead.
      if (destinationApi(c.env)) {
        return apiError(c, 409, "CONFLICT", "Verification status is read from Cloudflare; refresh it instead");
      }
      const db = createDb(c.env.DB);
      const now = new Date();
      const [updated] = await db
        .update(forwardingDestinations)
        .set({ verifiedAt: c.req.valid("json").verified ? now : null, updatedAt: now })
        .where(eq(forwardingDestinations.id, c.req.param("id")))
        .returning({ id: forwardingDestinations.id });
      if (!updated) return apiError(c, 404, "NOT_FOUND", "Destination not found");
      return c.json({ ok: true as const });
    },
  )
  .delete("/routing/destinations/:id", async (c) => {
    // Only removes it here; the Cloudflare destination stays for other uses.
    await createDb(c.env.DB)
      .delete(forwardingDestinations)
      .where(eq(forwardingDestinations.id, c.req.param("id")));
    return c.json({ ok: true as const });
  })
  .post(
    "/routing/addresses",
    zValidator("json", routingAddressSchema),
    async (c) => {
      const db = createDb(c.env.DB);
      const input = c.req.valid("json");
      const domain = await domainForAddress(db, input.address);
      if (!domain) {
        return apiError(c, 400, "BAD_REQUEST", "Address domain is not configured");
      }
      const { localPart } = mailboxAddressParts(input.address);
      const [ownMailbox] = await db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(and(eq(mailboxes.domainId, domain.id), eq(mailboxes.localPart, localPart)))
        .limit(1);
      let mailboxId = input.mailboxId;
      if (ownMailbox) {
        if (mailboxId && mailboxId !== ownMailbox.id) {
          return apiError(c, 409, "CONFLICT", "Address belongs to another mailbox");
        }
        if (input.destinationIds.length === 0) {
          return apiError(c, 400, "BAD_REQUEST", "Choose a destination to forward this mailbox to");
        }
        mailboxId = ownMailbox.id;
      } else if (mailboxId) {
        const [target] = await db
          .select({ id: mailboxes.id })
          .from(mailboxes)
          .where(eq(mailboxes.id, mailboxId))
          .limit(1);
        if (!target) return apiError(c, 400, "BAD_REQUEST", "Unknown mailbox");
      } else if (input.destinationIds.length === 0) {
        return apiError(c, 400, "BAD_REQUEST", "Choose a mailbox or at least one destination");
      }
      if (input.destinationIds.length > 0) {
        const verified = await db
          .select({ id: forwardingDestinations.id, verifiedAt: forwardingDestinations.verifiedAt })
          .from(forwardingDestinations)
          .where(inArray(forwardingDestinations.id, input.destinationIds));
        if (
          verified.length !== input.destinationIds.length
          || verified.some((destination) => destination.verifiedAt === null)
        ) {
          return apiError(c, 409, "CONFLICT", "Destinations must exist and be verified");
        }
      }
      const id = createId("rta");
      try {
        await db.batch([
          db.insert(routingAddresses).values({
            id,
            domainId: domain.id,
            localPart,
            mailboxId,
            keepCopy: input.keepCopy,
            createdByUserId: c.get("user").id,
          }),
          ...input.destinationIds.map((destinationId) =>
            db.insert(routingAddressDestinations).values({ addressId: id, destinationId })),
        ]);
      } catch {
        return apiError(c, 409, "CONFLICT", "Address is already routed");
      }
      return c.json({ ok: true as const, addressId: id }, 201);
    },
  )
  .delete("/routing/addresses/:id", async (c) => {
    await createDb(c.env.DB)
      .delete(routingAddresses)
      .where(eq(routingAddresses.id, c.req.param("id")));
    return c.json({ ok: true as const });
  })
  .put(
    "/routing/domains/:id/unknown-recipients",
    zValidator("json", unknownRecipientSchema),
    async (c) => {
      const db = createDb(c.env.DB);
      const { mailboxId } = c.req.valid("json");
      if (mailboxId) {
        const [target] = await db
          .select({ id: mailboxes.id })
          .from(mailboxes)
          .where(eq(mailboxes.id, mailboxId))
          .limit(1);
        if (!target) return apiError(c, 400, "BAD_REQUEST", "Unknown mailbox");
      }
      const [updated] = await db
        .update(domains)
        .set({ unknownRecipientMailboxId: mailboxId, updatedAt: new Date() })
        .where(eq(domains.id, c.req.param("id")))
        .returning({ id: domains.id });
      if (!updated) return apiError(c, 404, "NOT_FOUND", "Domain not found");
      return c.json({ ok: true as const });
    },
  );
