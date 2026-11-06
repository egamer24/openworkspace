import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  checkDomain,
  CloudflareApiError,
  ensureDomain,
  runOnboarding,
  type CloudflareApi,
  type OnboardingContext,
} from "../worker/admin/cloudflare-onboarding";
import { createDb } from "../worker/db/client";
import { domainOnboardingSteps, domains, users } from "../worker/db/schema";

type Record = {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
};
type Rule = {
  enabled: boolean;
  matchers: { type: string }[];
  actions: { type: string; value?: string[] }[];
};

/** In-memory stand-in for the subset of the Cloudflare API onboarding uses. */
class FakeCloudflare implements CloudflareApi {
  routingEnabled = false;
  records: Record[] = [];
  catchAll: Rule = { enabled: false, matchers: [{ type: "all" }], actions: [{ type: "drop" }] };
  subdomains: { tag: string; name: string }[] = [];
  failures = new Map<string, CloudflareApiError>();
  writes: string[] = [];
  private nextId = 1;

  constructor(readonly hostname: string) {}

  private cloudflareMx() {
    return [1, 2, 3].map((n) => ({
      id: `cf${n}`,
      type: "MX",
      name: this.hostname,
      content: `route${n}.mx.cloudflare.net`,
      priority: n,
    }));
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const route = `${method} ${path.split("?")[0]}`;
    if (method !== "GET") this.writes.push(route);
    const failure = this.failures.get(route);
    if (failure) {
      this.failures.delete(route);
      throw failure;
    }
    const zone = "/zones/zone1";
    const result = (() => {
      switch (route) {
        case `GET ${zone}/dns_records`:
          return this.records.filter((record) => record.type === "MX");
        case `POST ${zone}/dns_records`:
          this.records.push({ ...(body as Record), id: `r${this.nextId++}` });
          return {};
        case `GET ${zone}/email/routing`:
          return { enabled: this.routingEnabled };
        case `POST ${zone}/email/routing/dns`:
          this.routingEnabled = true;
          this.records.push(...this.cloudflareMx());
          return { enabled: true };
        case `DELETE ${zone}/email/routing/dns`:
          this.routingEnabled = false;
          this.records = this.records.filter((record) => !record.id.startsWith("cf"));
          return {};
        case `GET ${zone}/email/routing/rules/catch_all`:
          return structuredClone(this.catchAll);
        case `PUT ${zone}/email/routing/rules/catch_all`: {
          const { enabled, matchers, actions } = body as Rule;
          this.catchAll = { enabled, matchers, actions };
          return this.catchAll;
        }
        case `GET ${zone}/email/sending/subdomains`:
          return this.subdomains;
        case `POST ${zone}/email/sending/subdomains`: {
          const created = { tag: `s${this.nextId++}`, name: (body as { name: string }).name };
          this.subdomains.push(created);
          return created;
        }
      }
      const recordId = path.match(/\/dns_records\/(\w+)$/u)?.[1];
      if (method === "DELETE" && recordId) {
        this.records = this.records.filter((record) => record.id !== recordId);
        return {};
      }
      const tag = path.match(/\/email\/sending\/subdomains\/(\w+)$/u)?.[1];
      if (method === "DELETE" && tag) {
        this.subdomains = this.subdomains.filter((subdomain) => subdomain.tag !== tag);
        return {};
      }
      throw new Error(`Unexpected Cloudflare request: ${route}`);
    })();
    return result as T;
  }
}

const db = createDb(env.DB);
let userId: string;
let hostname: string;
let cloudflare: FakeCloudflare;
let context: OnboardingContext;

const connect = (replaceMx = false) => runOnboarding(db, context, {
  domain: () => ensureDomain(db, hostname, userId),
  replaceMx,
});
const statuses = (steps: { step: string; status: string }[]) =>
  Object.fromEntries(steps.map(({ step, status }) => [step, status]));
const foreignMx = { id: "g1", type: "MX", name: "", content: "smtp.google.com", priority: 1 };

describe("Cloudflare domain onboarding", () => {
  beforeEach(async () => {
    userId = `usr_${crypto.randomUUID()}`;
    hostname = `${crypto.randomUUID().slice(0, 8)}.example.org`;
    await db.insert(users).values({ id: userId, name: "Admin", role: "admin", status: "active" });
    cloudflare = new FakeCloudflare(hostname);
    context = {
      api: cloudflare,
      zone: { id: "zone1", name: "example.org" },
      hostname,
      workerName: "openworkspace",
    };
  });

  it("runs every step on a fresh zone and saves the zone ID", async () => {
    const result = await connect();

    expect(result.outcome).toBe("connected");
    expect(statuses(result.steps)).toEqual({
      routing: "ok",
      catch_all: "ok",
      sending: "ok",
      events: "manual",
      zone: "ok",
    });
    expect(cloudflare.catchAll).toEqual({
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: ["openworkspace"] }],
    });
    const [domain] = await db.select().from(domains).where(eq(domains.name, hostname));
    expect(domain?.cloudflareZoneId).toBe("zone1");
    const stored = await db.select().from(domainOnboardingSteps)
      .where(eq(domainOnboardingSteps.domainId, domain!.id));
    expect(stored).toHaveLength(5);
  });

  it("skips every step on an already configured zone without writing", async () => {
    await connect();
    cloudflare.writes = [];

    const result = await connect();

    expect(statuses(result.steps)).toEqual({
      routing: "skipped",
      catch_all: "skipped",
      sending: "skipped",
      events: "manual",
      zone: "skipped",
    });
    expect(cloudflare.writes).toEqual([]);
  });

  it("stops at preflight when the domain has foreign MX records", async () => {
    cloudflare.records.push({ ...foreignMx, name: hostname });

    const result = await connect();

    expect(result.outcome).toBe("mx_conflict");
    expect(result.preflight.foreignMx).toEqual([
      { content: "smtp.google.com", priority: 1 },
    ]);
    expect(cloudflare.writes).toEqual([]);
    expect(await db.select().from(domains).where(eq(domains.name, hostname))).toEqual([]);
  });

  it("rolls back only this run's changes when a later step fails", async () => {
    cloudflare.records.push({ ...foreignMx, name: hostname });
    const previousCatchAll = {
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "forward", value: ["owner@example.net"] }],
    };
    cloudflare.catchAll = structuredClone(previousCatchAll);
    cloudflare.failures.set(
      "POST /zones/zone1/email/sending/subdomains",
      new CloudflareApiError("1000 Internal error", 500, [1000]),
    );

    const result = await connect(true);

    expect(result.outcome).toBe("failed");
    expect(statuses(result.steps)).toEqual({
      routing: "rolled_back",
      catch_all: "rolled_back",
      sending: "failed",
    });
    expect(cloudflare.routingEnabled).toBe(false);
    expect(cloudflare.catchAll).toEqual(previousCatchAll);
    expect(cloudflare.records.map((record) => record.content)).toEqual(["smtp.google.com"]);
    expect(cloudflare.subdomains).toEqual([]);
  });

  it("keeps settings that existed before the run during rollback", async () => {
    cloudflare.routingEnabled = true;
    cloudflare.records.push(...[1, 2, 3].map((n) => ({
      id: `cf${n}`,
      type: "MX",
      name: hostname,
      content: `route${n}.mx.cloudflare.net`,
      priority: n,
    })));
    cloudflare.failures.set(
      "POST /zones/zone1/email/sending/subdomains",
      new CloudflareApiError("1000 Internal error", 500, [1000]),
    );

    const result = await connect();

    expect(statuses(result.steps)).toMatchObject({ routing: "skipped", sending: "failed" });
    expect(cloudflare.routingEnabled).toBe(true);
    expect(cloudflare.writes).not.toContain("DELETE /zones/zone1/email/routing/dns");
  });

  it("detects drift and repairs only the failed or drifted steps", async () => {
    cloudflare.failures.set(
      "PUT /zones/zone1/email/routing/rules/catch_all",
      new CloudflareApiError("10000 Authentication error", 403, [10000]),
    );
    const failed = await connect();
    expect(failed.outcome).toBe("failed");
    expect(failed.steps.find((step) => step.step === "catch_all")?.detail)
      .toBe("10000 Authentication error");

    const repaired = await connect();
    expect(repaired.outcome).toBe("connected");
    expect(statuses(repaired.steps)).toMatchObject({
      routing: "ok",
      catch_all: "ok",
      sending: "ok",
    });

    cloudflare.catchAll.enabled = false;
    const [domain] = await db.select().from(domains).where(eq(domains.name, hostname));
    expect(statuses(await checkDomain(context, domain!.cloudflareZoneId))).toEqual({
      routing: "ok",
      catch_all: "drifted",
      sending: "ok",
      events: "manual",
      zone: "ok",
    });

    cloudflare.writes = [];
    const fixed = await connect();
    expect(statuses(fixed.steps)).toMatchObject({
      routing: "skipped",
      catch_all: "ok",
      sending: "skipped",
    });
    expect(cloudflare.writes).toEqual(["PUT /zones/zone1/email/routing/rules/catch_all"]);
  });

  it("reports Cloudflare's 401 without foreign MX records as a token problem", async () => {
    cloudflare.failures.set(
      "POST /zones/zone1/email/sending/subdomains",
      new CloudflareApiError("2036 Unauthorized", 401, [2036]),
    );

    const result = await connect();

    expect(result.outcome).toBe("failed");
    expect(result.steps.find((step) => step.step === "sending")?.detail)
      .toMatch(/rejected the API token/u);
  });
});
