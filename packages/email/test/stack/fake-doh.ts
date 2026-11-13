/**
 * Offline DNS-over-HTTPS responder for the stack suite. Every DoH query the
 * test Worker or a Durable Object makes is answered here (worker.ts),
 * so sender intelligence never touches the network. Unknown names are
 * NXDOMAIN.
 */

const TYPE_CODES = new Map([
  ["A", 1],
  ["AAAA", 28],
  ["PTR", 12],
  ["TXT", 16],
]);

/** Records by type, then by name (no trailing dot). */
const records = new Map<string, Map<string, string[]>>([
  ["PTR", new Map([["181.2.243.46.in-addr.arpa", ["mx3.mail-relay.test."]]])],
  ["A", new Map([["mx3.mail-relay.test", ["46.243.2.181"]]])],
  [
    "TXT",
    new Map([
      [
        "181.2.243.46.origin.asn.cymru.com",
        ['"64496 | 46.243.0.0/16 | DE | ripencc | 2010-01-01"'],
      ],
      [
        "AS64496.asn.cymru.com",
        [
          '"64496 | DE | ripencc | 2010-01-01 | RELAY-NET - Example Relay Network GmbH, DE"',
        ],
      ],
    ]),
  ],
]);

export function fakeDohResponse(request: Request) {
  const url = new URL(request.url);
  const name = (url.searchParams.get("name") ?? "").replace(/\.$/u, "");
  const type = url.searchParams.get("type") ?? "A";
  const data = records.get(type)?.get(name);

  return Response.json(
    data
      ? {
          Status: 0,
          Answer: data.map((value) => ({
            name,
            type: TYPE_CODES.get(type),
            TTL: 300,
            data: value,
          })),
        }
      : { Status: 3 },
    { headers: { "content-type": "application/dns-json" } }
  );
}

export function isDohRequest(request: Request) {
  const host = new URL(request.url).hostname;

  return host === "cloudflare-dns.com" || host === "1.1.1.1";
}
