import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { createDb } from "../db/client";
import { domains } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import {
  checkDomain,
  CloudflareApiError,
  cloudflareApiFromEnv,
  ensureDomain,
  findZone,
  listZones,
  preflight,
  runOnboarding,
  saveSteps,
} from "./cloudflare-onboarding";
import { cloudflareConnectSchema, cloudflareDomainSchema } from "./schemas";

async function onboardingContext(c: Context<AppEnv>, hostname: string) {
  const api = cloudflareApiFromEnv(c.env);
  if (!api) return null;
  const zone = await findZone(api, hostname, c.env.CLOUDFLARE_ACCOUNT_ID);
  if (!zone) {
    throw new CloudflareApiError(
      `No active Cloudflare zone covering ${hostname} is visible to the API token`,
      404,
      [],
    );
  }
  return {
    api,
    zone,
    hostname,
    workerName: c.env.WORKER_NAME || "openworkspace",
  };
}

function notConfigured(c: Context<AppEnv>) {
  return apiError(c, 503, "UNAVAILABLE", "CLOUDFLARE_API_TOKEN is not configured");
}

function cloudflareError(c: Context<AppEnv>, error: unknown) {
  if (!(error instanceof CloudflareApiError)) throw error;
  console.warn("Cloudflare onboarding request failed", error.message);
  return apiError(c, 502, "BAD_GATEWAY", error.message);
}

export const cloudflareAdminRoutes = new Hono<AppEnv>()
  .get("/cloudflare/zones", async (c) => {
    const api = cloudflareApiFromEnv(c.env);
    if (!api) return notConfigured(c);
    try {
      const zones = await listZones(api, c.env.CLOUDFLARE_ACCOUNT_ID);
      return c.json({ ok: true as const, zones });
    } catch (error) {
      return cloudflareError(c, error);
    }
  })
  .post(
    "/cloudflare/preflight",
    zValidator("json", cloudflareDomainSchema),
    async (c) => {
      try {
        const context = await onboardingContext(c, c.req.valid("json").name);
        if (!context) return notConfigured(c);
        return c.json({ ok: true as const, ...await preflight(context) });
      } catch (error) {
        return cloudflareError(c, error);
      }
    },
  )
  .post(
    "/cloudflare/connect",
    zValidator("json", cloudflareConnectSchema),
    async (c) => {
      const input = c.req.valid("json");
      try {
        const context = await onboardingContext(c, input.name);
        if (!context) return notConfigured(c);
        const db = createDb(c.env.DB);
        const result = await runOnboarding(db, context, {
          domain: () => ensureDomain(db, input.name, c.get("user").id),
          replaceMx: input.replaceMx,
        });
        return c.json({ ok: true as const, ...result });
      } catch (error) {
        return cloudflareError(c, error);
      }
    },
  )
  .post("/domains/:id/cloudflare/check", async (c) => {
    const db = createDb(c.env.DB);
    const domainId = c.req.param("id");
    const [domain] = await db
      .select({ name: domains.name, cloudflareZoneId: domains.cloudflareZoneId })
      .from(domains)
      .where(eq(domains.id, domainId))
      .limit(1);
    if (!domain) return apiError(c, 404, "NOT_FOUND", "Domain not found");
    try {
      const context = await onboardingContext(c, domain.name);
      if (!context) return notConfigured(c);
      const steps = await checkDomain(context, domain.cloudflareZoneId);
      await saveSteps(db, domainId, steps);
      return c.json({ ok: true as const, domainId, steps });
    } catch (error) {
      return cloudflareError(c, error);
    }
  });
