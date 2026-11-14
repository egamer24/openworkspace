import { z } from "zod";

/**
 * Email Routing's destination addresses: where a `forward` address may send
 * mail. Cloudflare emails each new destination a link, and forwards to it
 * only once that link was followed.
 *
 * The Worker calls the API with the token `Email()` mints (alchemy/index.ts).
 * `alchemy dev` binds none, so locally `emailRoutingApi` is null: no
 * destination is created and none counts as confirmed. The stack tests bind
 * placeholders and answer these requests like any outgoing request
 * (test/stack/fake-email-routing.ts).
 */
const API_BASE = "https://api.cloudflare.com/client/v4";

/** Pages of destinations read at most; an account rarely has more than a few. */
const MAX_PAGES = 20;

const PER_PAGE = 50;

const destinationsPage = z.object({
  success: z.boolean(),
  result: z
    .array(
      z.object({
        email: z.string(),
        // When the destination followed its confirmation link; null until then.
        verified: z.string().nullish(),
      })
    )
    .nullish(),
});

export type DestinationStatus = "confirmed" | "waiting";

function emailRoutingApi(env: Env) {
  const accountId = env.EMAIL_ROUTING_ACCOUNT_ID;
  const token = env.EMAIL_ROUTING_API_TOKEN;

  if (!accountId || !token) return null;

  return {
    url: `${API_BASE}/accounts/${encodeURIComponent(accountId)}/email/routing/addresses`,
    headers: { authorization: `Bearer ${token}` },
  };
}

/**
 * Every destination address of the account, by lowercase address; null when
 * Email Routing isn't connected (local development).
 */
export async function destinationStatuses(env: Env) {
  const api = emailRoutingApi(env);

  if (!api) return null;
  const statuses = new Map<string, DestinationStatus>();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each page says whether there is another
    const response = await fetch(
      `${api.url}?page=${page}&per_page=${PER_PAGE}`,
      { headers: api.headers }
    );

    if (!response.ok) {
      throw new Error(
        `Email Routing answered ${response.status} listing destinations`
      );
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- each page says whether there is another
    const body = destinationsPage.parse(await response.json());
    const rows = body.result ?? [];

    for (const row of rows) {
      statuses.set(
        row.email.toLowerCase(),
        row.verified ? "confirmed" : "waiting"
      );
    }

    if (rows.length < PER_PAGE) break;
  }

  return statuses;
}

/**
 * Adds the addresses Email Routing doesn't have yet as destinations, so
 * Cloudflare emails each one its confirmation link. Throws if one fails.
 */
export async function createDestinations(env: Env, addresses: string[]) {
  const api = emailRoutingApi(env);
  const known = await destinationStatuses(env);

  if (!api || !known) return;

  const results = await Promise.allSettled(
    addresses
      .flatMap((email) => (known.has(email.toLowerCase()) ? [] : [email]))
      .map(async (email) => {
        const response = await fetch(api.url, {
          method: "POST",
          headers: { ...api.headers, "content-type": "application/json" },
          body: JSON.stringify({ email }),
        });

        if (!response.ok) {
          throw new Error(
            `Email Routing answered ${response.status} adding ${email}`
          );
        }
      })
  );

  const failed = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );

  if (failed.length) {
    throw new AggregateError(failed, "Some forward destinations weren't added");
  }
}
