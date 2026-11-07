import { describe, expect, it } from "vitest";
import { fetchCloudflareEmailAuthentication } from "../worker/mail/email-authentication";

describe("Cloudflare email authentication", () => {
  it("matches the exact Message-ID and normalizes the authentication result", async () => {
    const timelineAt = Date.parse("2026-08-23T12:00:00.000Z");
    let request: RequestInit | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      request = init;
      return Response.json({
        data: {
          viewer: {
            zones: [{
              emailRoutingAdaptive: [{
                action: "worker",
                datetime: "2026-08-23T12:00:03.000Z",
                dkim: "PASS",
                dmarc: "pass",
                isLastEvent: 1,
                isSpam: 0,
                messageId: "<wanted@example.com>",
                spamScore: 2.5,
                spamThreshold: 5,
                spf: "Pass",
                status: "handled",
              }, {
                datetime: "2026-08-23T12:00:01.000Z",
                dkim: "fail",
                dmarc: "fail",
                isLastEvent: 1,
                isSpam: 1,
                messageId: "<other@example.com>",
                spf: "fail",
              }],
            }],
          },
        },
      });
    };

    await expect(fetchCloudflareEmailAuthentication({
      zoneId: "zone-id",
      token: "analytics-token",
      messageId: "wanted@example.com",
      timelineAt,
      fetcher,
      now: () => timelineAt + 10_000,
    })).resolves.toEqual({
      source: "cloudflare",
      checkedAt: timelineAt + 10_000,
      eventAt: timelineAt + 3_000,
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      arc: null,
      isSpam: false,
      spamScore: 2.5,
      spamThreshold: 5,
    });

    expect(request?.headers).toMatchObject({
      authorization: "Bearer analytics-token",
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      variables: {
        zoneTag: "zone-id",
        filter: {
          datetime_geq: "2026-08-23T11:58:00.000Z",
          datetime_leq: "2026-08-23T12:02:00.000Z",
        },
      },
    });
  });

  it("returns nothing when the Message-ID is ambiguous or results were cut off", async () => {
    const timelineAt = Date.parse("2026-08-23T12:00:00.000Z");
    const event = (overrides: Record<string, unknown>) => ({
      datetime: "2026-08-23T12:00:01.000Z", dkim: "pass", dmarc: "pass", spf: "pass",
      isSpam: 0, messageId: "<reused@example.com>", ...overrides,
    });
    const lookup = (events: unknown[]) => fetchCloudflareEmailAuthentication({
      zoneId: "zone-id",
      token: "analytics-token",
      messageId: "reused@example.com",
      timelineAt,
      fetcher: async () => Response.json({ data: { viewer: { zones: [{ emailRoutingAdaptive: events }] } } }),
    });
    // A forged copy and the attacker's passing copy share the Message-ID.
    await expect(lookup([event({}), event({ dmarc: "fail", spf: "fail", isSpam: 1 })])).resolves.toBeNull();
    await expect(lookup(Array.from({ length: 250 }, () => event({})))).resolves.toBeNull();
    // Several events of one delivery agree.
    await expect(lookup([event({}), event({ action: "worker" })])).resolves.toMatchObject({ dmarc: "pass" });
  });
});
