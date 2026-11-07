import { z } from "zod";
import type { EmailAuthenticationResults } from "../mailbox/model";

export type CloudflareEmailAnalyticsBindings = {
  CLOUDFLARE_ANALYTICS_TOKEN?: string;
};

export const CLOUDFLARE_EMAIL_ANALYTICS_RETENTION_MS =
  31 * 24 * 60 * 60 * 1_000;

const EVENT_WINDOW_MS = 2 * 60 * 1_000;
const EVENT_LIMIT = 250;
const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const EMAIL_ROUTING_QUERY = `
  query EmailRoutingAuthentication(
    $zoneTag: string,
    $filter: EmailRoutingAdaptiveFilter_InputObject
  ) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        emailRoutingAdaptive(
          filter: $filter
          limit: ${EVENT_LIMIT}
          orderBy: [datetime_DESC]
        ) {
          action
          arc
          datetime
          dkim
          dmarc
          isLastEvent
          isSpam
          messageId
          spamScore
          spamThreshold
          spf
          status
        }
      }
    }
  }
`;

const routingEventSchema = z.object({
  action: z.string().optional(),
  arc: z.string().nullable().optional(),
  datetime: z.string(),
  dkim: z.string().nullable().optional(),
  dmarc: z.string().nullable().optional(),
  isLastEvent: z.union([z.number(), z.boolean()]).optional(),
  isSpam: z.union([z.number(), z.boolean()]),
  messageId: z.string(),
  spamScore: z.number().nullable().optional(),
  spamThreshold: z.number().nullable().optional(),
  spf: z.string().nullable().optional(),
  status: z.string().optional(),
});

const analyticsResponseSchema = z.object({
  data: z.object({
    viewer: z.object({
      zones: z.array(z.object({
        emailRoutingAdaptive: z.array(routingEventSchema),
      })),
    }),
  }).nullable().optional(),
  errors: z.array(z.object({ message: z.string().optional() })).nullable().optional(),
});

type RoutingEvent = z.infer<typeof routingEventSchema>;

function normalizedMessageId(value: string) {
  return value.trim().replace(/^<|>$/gu, "").toLocaleLowerCase();
}

function verdict(value: string | null | undefined) {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized ? normalized.slice(0, 64) : null;
}

function eventPriority(event: RoutingEvent, timelineAt: number) {
  const eventAt = Date.parse(event.datetime);
  return (
    (event.isLastEvent === true || event.isLastEvent === 1 ? 4 : 0)
    + (event.action === "worker" ? 2 : 0)
    + (event.status === "handled" ? 1 : 0)
    - (Number.isNaN(eventAt) ? EVENT_WINDOW_MS : Math.abs(eventAt - timelineAt))
      / EVENT_WINDOW_MS
  );
}

export async function fetchCloudflareEmailAuthentication(input: {
  zoneId: string;
  token: string;
  messageId: string;
  timelineAt: number;
  fetcher?: typeof fetch;
  now?: () => number;
}): Promise<EmailAuthenticationResults | null> {
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: EMAIL_ROUTING_QUERY,
      variables: {
        zoneTag: input.zoneId,
        filter: {
          datetime_geq: new Date(input.timelineAt - EVENT_WINDOW_MS).toISOString(),
          datetime_leq: new Date(input.timelineAt + EVENT_WINDOW_MS).toISOString(),
        },
      },
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare email analytics returned ${response.status}`);
  }

  const body = analyticsResponseSchema.parse(await response.json());
  if (body.errors?.length) {
    throw new Error(
      body.errors[0]?.message || "Cloudflare email analytics query failed",
    );
  }
  const expectedMessageId = normalizedMessageId(input.messageId);
  const events = body.data?.viewer.zones.flatMap(
    (zone) => zone.emailRoutingAdaptive,
  ) ?? [];
  // The Message-ID is chosen by the sender, so it does not identify one
  // delivery: another message can reuse it within the window (to any address
  // in the zone), or later traffic can push this one past the row limit.
  // Show nothing rather than another message's verdict.
  if (events.length >= EVENT_LIMIT) return null;
  const matches = events
    .filter((candidate) =>
      normalizedMessageId(candidate.messageId) === expectedMessageId
    );
  const verdicts = new Set(matches.map((candidate) => JSON.stringify([
    verdict(candidate.spf),
    verdict(candidate.dkim),
    verdict(candidate.dmarc),
    candidate.isSpam === true || candidate.isSpam === 1,
  ])));
  if (verdicts.size > 1) return null;
  const event = matches
    .sort((left, right) =>
      eventPriority(right, input.timelineAt) - eventPriority(left, input.timelineAt)
    )[0];
  if (!event) return null;

  const eventAt = Date.parse(event.datetime);
  if (Number.isNaN(eventAt)) {
    throw new Error("Cloudflare email analytics returned an invalid timestamp");
  }
  return {
    source: "cloudflare",
    checkedAt: (input.now ?? Date.now)(),
    eventAt,
    spf: verdict(event.spf),
    dkim: verdict(event.dkim),
    dmarc: verdict(event.dmarc),
    arc: verdict(event.arc),
    isSpam: event.isSpam === true || event.isSpam === 1,
    spamScore: event.spamScore ?? null,
    spamThreshold: event.spamThreshold ?? null,
  };
}
