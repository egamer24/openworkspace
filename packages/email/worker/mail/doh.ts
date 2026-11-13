import { z } from "zod";

import type { LookupStatus } from "../../shared/mail-sender-intel";

/**
 * DNS-over-HTTPS (JSON API) client. Workers have no raw UDP, so every DNS
 * lookup in sender intelligence goes through this one mockable function.
 * https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
 */

export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

export type DnsRecordType = "A" | "AAAA" | "PTR" | "TXT";

const recordTypeCodes: Record<DnsRecordType, number> = {
  A: 1,
  AAAA: 28,
  PTR: 12,
  TXT: 16,
};

export type DnsAnswer = {
  status: Exclude<LookupStatus, "skipped">;
  /** Answer data of the requested type; TXT strings are unquoted and joined. */
  records: string[];
};

export type DnsResolver = (
  name: string,
  type: DnsRecordType
) => Promise<DnsAnswer>;

/** The JSON API's answer; an answer record of an unexpected shape is skipped. */
const DohJson = z.object({
  Status: z.number().optional(),
  Answer: z
    .array(
      z.object({
        type: z.number().optional().catch(undefined),
        data: z.string().optional().catch(undefined),
      })
    )
    .optional(),
});

/** `"v=BIMI1; " "l=https://…"` → `v=BIMI1; l=https://…` (RFC 7208 §3.3 joining). */
export function txtData(value: string) {
  const chunks = [...value.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((match) =>
    match[1].replaceAll(/\\(.)/gu, "$1")
  );

  return chunks.length ? chunks.join("") : value;
}

export function isAbortError(cause: unknown) {
  return (
    cause instanceof Error &&
    (cause.name === "AbortError" || cause.name === "TimeoutError")
  );
}

export function createDohResolver(
  options: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    endpoint?: string;
  } = {}
): DnsResolver {
  const fetcher = options.fetch ?? fetch;
  const endpoint = options.endpoint ?? DOH_ENDPOINT;

  return async (name, type) => {
    if (options.signal?.aborted) return { status: "timeout", records: [] };
    const url = new URL(endpoint);
    url.searchParams.set("name", name);
    url.searchParams.set("type", type);

    try {
      const response = await fetcher(url, {
        headers: { accept: "application/dns-json" },
        signal: options.signal,
      });

      if (!response.ok) return { status: "error", records: [] };
      const parsed = DohJson.safeParse(await response.json());

      if (!parsed.success) return { status: "error", records: [] };
      const body = parsed.data;

      if (body.Status === 3) return { status: "nxdomain", records: [] };

      if (body.Status !== 0) return { status: "error", records: [] };
      const code = recordTypeCodes[type];

      const records = (body.Answer ?? []).flatMap((answer) => {
        if (answer.type !== code || answer.data === undefined) return [];
        const data = answer.data.trim();

        if (type === "TXT") return [txtData(data)];

        return [data.replace(/\.$/u, "").toLocaleLowerCase()];
      });

      return { status: "ok", records };
    } catch (error) {
      return {
        status:
          isAbortError(error) || options.signal?.aborted ? "timeout" : "error",
        records: [],
      };
    }
  };
}
