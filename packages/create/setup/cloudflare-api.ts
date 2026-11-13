// The few Cloudflare API reads create needs: the accounts a login reaches,
// an account's zones, and a zone's MX records. Authenticated with the
// credentials Alchemy resolved, so they see what the deploy will.
import { z } from "zod";

import type { CloudflareAuth } from "./alchemy-protocol.ts";
import type { Account, MxRecord, Zone } from "./domains.ts";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type CloudflareApi = {
  accounts(): Promise<Account[]>;
  zones(accountId: string): Promise<Zone[]>;
  mxRecords(zoneId: string): Promise<MxRecord[]>;
};

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const envelopeSchema = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ code: z.number(), message: z.string() })),
  result: z.array(z.unknown()).nullable(),
  result_info: z
    .object({ page: z.number(), total_pages: z.number() })
    .partial()
    .optional(),
});

const accountSchema = z.object({ id: z.string(), name: z.string() });

const membershipSchema = z.object({
  status: z.string().optional(),
  account: accountSchema.nullable().optional(),
});

const zoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
});

const mxSchema = z.object({
  name: z.string(),
  content: z.string(),
  priority: z.number().optional(),
});

function headers(auth: CloudflareAuth): Record<string, string> {
  return auth.type === "token"
    ? { Authorization: `Bearer ${auth.token}` }
    : { "X-Auth-Key": auth.key, "X-Auth-Email": auth.email };
}

export function cloudflareApi(
  auth: CloudflareAuth,
  fetchImpl: Fetch = fetch,
  base = CLOUDFLARE_API
): CloudflareApi {
  /** One page of a list endpoint: its items, parsed, and how many pages there are. */
  async function page<T>(path: string, item: z.ZodType<T>, number: number) {
    const url = new URL(`${base}${path}`);

    url.searchParams.set("page", String(number));

    const response = await fetchImpl(url.toString(), {
      headers: { ...headers(auth), Accept: "application/json" },
    });

    const body = envelopeSchema.safeParse(
      await response.json().catch(() => null)
    );

    if (!response.ok || !body.success || !body.data.success) {
      const reason = body.success
        ? body.data.errors.map((error) => error.message).join("; ")
        : "";

      throw new CloudflareApiError(
        `GET ${url.pathname} failed with HTTP ${response.status}${reason ? `: ${reason}` : ""}`,
        response.status
      );
    }

    return {
      items: z.array(item).parse(body.data.result ?? []),
      pages: body.data.result_info?.total_pages ?? 1,
    };
  }

  /** Every page of a list endpoint. */
  async function list<T>(path: string, item: z.ZodType<T>) {
    const first = await page(path, item, 1);

    const rest = await Promise.all(
      Array.from({ length: Math.max(0, first.pages - 1) }, (_, index) =>
        page(path, item, index + 2)
      )
    );

    return [first, ...rest].flatMap((result) => result.items);
  }

  return {
    /**
     * Accounts the login reaches. Memberships list them for a user's OAuth
     * login; an account API token has none, so /accounts is the fallback
     * (as in Alchemy's own account picker).
     */
    async accounts() {
      const memberships = await list(
        "/memberships?per_page=50",
        membershipSchema
      ).catch(() => []);

      const accounts = memberships.flatMap((membership) =>
        membership.account &&
        (membership.status === undefined || membership.status === "accepted")
          ? [membership.account]
          : []
      );

      if (accounts.length > 0) return accounts;

      return list("/accounts?per_page=50", accountSchema);
    },

    zones(accountId) {
      return list(
        `/zones?per_page=50&account.id=${encodeURIComponent(accountId)}`,
        zoneSchema
      );
    },

    async mxRecords(zoneId) {
      const records = await list(
        `/zones/${encodeURIComponent(zoneId)}/dns_records?type=MX&per_page=100`,
        mxSchema
      );

      return records.map((record) => ({
        name: record.name,
        content: record.content,
        priority: record.priority ?? 0,
      }));
    },
  };
}
