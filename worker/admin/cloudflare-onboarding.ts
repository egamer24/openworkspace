import { eq } from "drizzle-orm";
import type {
  DomainOnboardingStatus,
  DomainOnboardingStep,
} from "../../shared/domain-onboarding";
import type { Database } from "../db/client";
import { domainOnboardingSteps, domains } from "../db/schema";
import { createId } from "../lib/ids";

const API_BASE = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_MX = /\.mx\.cloudflare\.net\.?$/iu;
// Cloudflare answers Email Sending onboarding with this code (and HTTP 401)
// when the hostname still has MX records for another mail provider.
const FOREIGN_MX_ERROR_CODE = 2036;

export type CloudflareApiBindings = {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  WORKER_NAME?: string;
};

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codes: number[],
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export type CloudflareApi = {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
};

type Envelope = {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: unknown;
};

export function cloudflareApi(
  token: string,
  fetcher: typeof fetch = fetch,
): CloudflareApi {
  return {
    async request<T>(method: string, path: string, body?: unknown) {
      const response = await fetcher(`${API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null) as Envelope | null;
      if (!response.ok || !payload?.success) {
        const errors = payload?.errors ?? [];
        throw new CloudflareApiError(
          errors.map((error) => `${error.code ?? ""} ${error.message ?? ""}`.trim())
            .join("; ") || `Cloudflare API request failed (${response.status})`,
          response.status,
          errors.flatMap((error) => error.code === undefined ? [] : [error.code]),
        );
      }
      return payload.result as T;
    },
  };
}

export function cloudflareApiFromEnv(env: CloudflareApiBindings) {
  return env.CLOUDFLARE_API_TOKEN ? cloudflareApi(env.CLOUDFLARE_API_TOKEN) : null;
}

type Zone = { id: string; name: string };
type DnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  ttl?: number;
};
type CatchAllRule = {
  name?: string;
  enabled?: boolean;
  matchers?: { type: string }[];
  actions?: { type: string; value?: string[] }[];
};
type SendingSubdomain = { tag?: string; id?: string; name: string };

export type OnboardingContext = {
  api: CloudflareApi;
  zone: Zone;
  hostname: string;
  workerName: string;
};

export type StepResult = {
  step: DomainOnboardingStep;
  status: DomainOnboardingStatus;
  detail: string | null;
};

const EVENTS_DETAIL = "Subscribe the openworkspace-delivery-events queue to Email Sending "
  + "for this domain in Queues → Subscriptions (all six message.* events). "
  + "Cloudflare's API does not document an Email Sending event source yet.";

export async function listZones(api: CloudflareApi, accountId?: string) {
  const zones: Zone[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const query = new URLSearchParams({
      status: "active",
      per_page: "50",
      page: String(page),
    });
    if (accountId) query.set("account.id", accountId);
    const batch = await api.request<Zone[]>("GET", `/zones?${query}`);
    zones.push(...batch.map(({ id, name }) => ({ id, name })));
    if (batch.length < 50) break;
  }
  return zones;
}

/** Walks up from the hostname so subdomains resolve to their parent zone. */
export async function findZone(
  api: CloudflareApi,
  hostname: string,
  accountId?: string,
) {
  const labels = hostname.split(".");
  for (let index = 0; index < labels.length - 1; index += 1) {
    const query = new URLSearchParams({
      name: labels.slice(index).join("."),
      status: "active",
    });
    if (accountId) query.set("account.id", accountId);
    const [zone] = await api.request<Zone[]>("GET", `/zones?${query}`);
    if (zone) return { id: zone.id, name: zone.name };
  }
  return null;
}

async function mxRecords({ api, zone, hostname }: OnboardingContext) {
  const query = new URLSearchParams({
    type: "MX",
    "name.exact": hostname,
    per_page: "100",
  });
  return api.request<DnsRecord[]>(
    "GET",
    `/zones/${zone.id}/dns_records?${query}`,
  );
}

const foreign = (records: DnsRecord[]) =>
  records.filter((record) => !CLOUDFLARE_MX.test(record.content));

async function catchAllRule({ api, zone }: OnboardingContext) {
  return api.request<CatchAllRule>(
    "GET",
    `/zones/${zone.id}/email/routing/rules/catch_all`,
  );
}

function catchAllTargetsWorker(rule: CatchAllRule, workerName: string) {
  const [action] = rule.actions ?? [];
  return rule.enabled === true
    && action?.type === "worker"
    && (action.value ?? []).includes(workerName);
}

function describeCatchAll(rule: CatchAllRule) {
  const [action] = rule.actions ?? [];
  if (!rule.enabled || !action) return "disabled";
  return [action.type, ...(action.value ?? [])].join(" ");
}

async function sendingSubdomain({ api, zone, hostname }: OnboardingContext) {
  const subdomains = await api.request<SendingSubdomain[]>(
    "GET",
    `/zones/${zone.id}/email/sending/subdomains`,
  );
  return subdomains.find((subdomain) => subdomain.name === hostname) ?? null;
}

/** Read-only: what connecting this hostname would change. */
export async function preflight(context: OnboardingContext) {
  const [mx, catchAll] = await Promise.all([
    mxRecords(context),
    catchAllRule(context).catch(() => null),
  ]);
  return {
    zone: context.zone,
    hostname: context.hostname,
    foreignMx: foreign(mx).map(({ content, priority }) => ({ content, priority })),
    catchAll: catchAll
      ? {
          current: describeCatchAll(catchAll),
          targetsThisWorker: catchAllTargetsWorker(catchAll, context.workerName),
        }
      : null,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function readStep(
  step: DomainOnboardingStep,
  read: () => Promise<boolean>,
): Promise<StepResult> {
  try {
    return { step, status: await read() ? "ok" : "drifted", detail: null };
  } catch (error) {
    return { step, status: "failed", detail: errorMessage(error) };
  }
}

/** Re-reads every step from Cloudflare without changing anything. */
export async function checkDomain(
  context: OnboardingContext,
  savedZoneId: string | null,
): Promise<StepResult[]> {
  const { api, zone } = context;
  return [
    await readStep("routing", async () => {
      const [settings, mx] = await Promise.all([
        api.request<{ enabled?: boolean }>("GET", `/zones/${zone.id}/email/routing`),
        mxRecords(context),
      ]);
      return settings.enabled === true
        && mx.length > 0
        && foreign(mx).length === 0;
    }),
    await readStep("catch_all", async () =>
      catchAllTargetsWorker(await catchAllRule(context), context.workerName)),
    await readStep("sending", async () => Boolean(await sendingSubdomain(context))),
    { step: "events", status: "manual", detail: EVENTS_DETAIL },
    {
      step: "zone",
      status: savedZoneId === zone.id ? "ok" : "drifted",
      detail: null,
    },
  ];
}

type Undo = { step: DomainOnboardingStep; run: () => Promise<unknown> };

class StepFailure extends Error {
  constructor(message: string, readonly mxConflict = false) {
    super(message);
  }
}

/**
 * Applies every step that is not already in place. Each step is idempotent:
 * steps that check out are reported as skipped, so "Repair" is the same call.
 * When a step fails, only changes made by this run are undone, newest first.
 */
export async function runOnboarding(
  db: Database,
  context: OnboardingContext,
  input: {
    domain: () => Promise<{ id: string; cloudflareZoneId: string | null }>;
    replaceMx: boolean;
  },
) {
  const { api, zone, hostname, workerName } = context;
  const before = await preflight(context);
  if (before.foreignMx.length > 0 && !input.replaceMx) {
    return {
      outcome: "mx_conflict" as const,
      domainId: null,
      preflight: before,
      steps: [],
    };
  }
  const domain = await input.domain();

  const current = new Map(
    (await checkDomain(context, domain.cloudflareZoneId))
      .map((result) => [result.step, result.status]),
  );
  const undo: Undo[] = [];
  const results: StepResult[] = [];
  const actions: [DomainOnboardingStep, () => Promise<void>][] = [
    ["routing", async () => {
      const mx = await mxRecords(context);
      for (const record of foreign(mx)) {
        await api.request("DELETE", `/zones/${zone.id}/dns_records/${record.id}`);
        undo.push({
          step: "routing",
          run: () => api.request("POST", `/zones/${zone.id}/dns_records`, {
            type: "MX",
            name: record.name,
            content: record.content,
            priority: record.priority,
            ttl: record.ttl ?? 1,
          }),
        });
      }
      const settings = await api.request<{ enabled?: boolean }>(
        "GET",
        `/zones/${zone.id}/email/routing`,
      );
      await api.request(
        "POST",
        `/zones/${zone.id}/email/routing/dns`,
        hostname === zone.name ? {} : { name: hostname },
      );
      // ponytail: when routing was already on for the zone, the subdomain's
      // new routing records stay on rollback; Cloudflare has no per-name undo.
      if (!settings.enabled) {
        undo.push({
          step: "routing",
          run: () => api.request("DELETE", `/zones/${zone.id}/email/routing/dns`),
        });
      }
    }],
    ["catch_all", async () => {
      const previous = await catchAllRule(context);
      await api.request("PUT", `/zones/${zone.id}/email/routing/rules/catch_all`, {
        name: "OpenWorkspace",
        enabled: true,
        matchers: [{ type: "all" }],
        actions: [{ type: "worker", value: [workerName] }],
      });
      undo.push({
        step: "catch_all",
        run: () => api.request("PUT", `/zones/${zone.id}/email/routing/rules/catch_all`, {
          name: previous.name,
          enabled: previous.enabled ?? false,
          matchers: previous.matchers ?? [{ type: "all" }],
          actions: previous.actions ?? [{ type: "drop" }],
        }),
      });
    }],
    ["sending", async () => {
      let created: SendingSubdomain;
      try {
        created = await api.request<SendingSubdomain>(
          "POST",
          `/zones/${zone.id}/email/sending/subdomains`,
          { name: hostname },
        );
      } catch (error) {
        if (
          error instanceof CloudflareApiError
          && (error.status === 401 || error.codes.includes(FOREIGN_MX_ERROR_CODE))
        ) {
          if (foreign(await mxRecords(context)).length > 0) {
            throw new StepFailure(
              `${hostname} has MX records for another mail provider. `
                + "Confirm replacing them and run again.",
              true,
            );
          }
          throw new StepFailure(
            `Cloudflare rejected the API token (${error.message}). `
              + "Check that it has Email Sending: Edit for this account.",
          );
        }
        throw error;
      }
      const id = created.tag ?? created.id;
      if (id) {
        undo.push({
          step: "sending",
          run: () => api.request(
            "DELETE",
            `/zones/${zone.id}/email/sending/subdomains/${id}`,
          ),
        });
      }
    }],
  ];

  let failure: StepFailure | null = null;
  for (const [step, apply] of actions) {
    if (current.get(step) === "ok") {
      results.push({ step, status: "skipped", detail: null });
      continue;
    }
    try {
      await apply();
      results.push({ step, status: "ok", detail: null });
    } catch (error) {
      failure = error instanceof StepFailure
        ? error
        : new StepFailure(errorMessage(error));
      results.push({ step, status: "failed", detail: failure.message });
      break;
    }
  }

  if (failure) {
    const rollbackErrors = new Map<DomainOnboardingStep, string>();
    for (const change of undo.reverse()) {
      try {
        await change.run();
      } catch (error) {
        rollbackErrors.set(change.step, errorMessage(error));
      }
    }
    const undone = new Set(undo.map((change) => change.step));
    for (const result of results) {
      if (result.status !== "ok" || !undone.has(result.step)) continue;
      const rollbackError = rollbackErrors.get(result.step);
      result.status = rollbackError ? "failed" : "rolled_back";
      result.detail = rollbackError ? `Rollback failed: ${rollbackError}` : null;
    }
  } else {
    results.push({ step: "events", status: "manual", detail: EVENTS_DETAIL });
    if (domain.cloudflareZoneId === zone.id) {
      results.push({ step: "zone", status: "skipped", detail: null });
    } else {
      await db.update(domains)
        .set({ cloudflareZoneId: zone.id, updatedAt: new Date() })
        .where(eq(domains.id, domain.id));
      results.push({ step: "zone", status: "ok", detail: null });
    }
  }

  await saveSteps(db, domain.id, results);
  return {
    domainId: domain.id,
    outcome: failure?.mxConflict
      ? "mx_conflict" as const
      : failure ? "failed" as const : "connected" as const,
    preflight: before,
    steps: results,
  };
}

export async function saveSteps(
  db: Database,
  domainId: string,
  results: StepResult[],
) {
  const updatedAt = new Date();
  for (const { step, status, detail } of results) {
    await db.insert(domainOnboardingSteps)
      .values({ domainId, step, status, detail, updatedAt })
      .onConflictDoUpdate({
        target: [domainOnboardingSteps.domainId, domainOnboardingSteps.step],
        set: { status, detail, updatedAt },
      });
  }
}

/** Finds or creates the domain row that onboarding results attach to. */
export async function ensureDomain(
  db: Database,
  hostname: string,
  userId: string,
) {
  const now = new Date();
  await db.insert(domains).values({
    id: createId("dom"),
    name: hostname,
    cloudflareZoneId: null,
    isPrimary: false,
    createdByUserId: userId,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  const [domain] = await db
    .select({ id: domains.id, cloudflareZoneId: domains.cloudflareZoneId })
    .from(domains)
    .where(eq(domains.name, hostname))
    .limit(1);
  return domain!;
}
