import { describe, expect, test } from "bun:test";

import {
  cloudflareApi,
  CloudflareApiError,
} from "../../setup/cloudflare-api.ts";
import type { Fetch } from "../../setup/cloudflare-api.ts";

type Route = (url: URL, headers: Headers) => { status?: number; body: unknown };

/** A fetch that records each request and answers from `route`. */
function recording(route: Route) {
  const requests: { url: URL; headers: Headers }[] = [];

  const fetchImpl: Fetch = (url, init) => {
    const request = { url: new URL(url), headers: new Headers(init.headers) };

    requests.push(request);

    const { status = 200, body } = route(request.url, request.headers);

    return Promise.resolve(Response.json(body, { status }));
  };

  return { requests, fetchImpl };
}

function page(result: unknown[], pageNumber = 1, totalPages = 1) {
  return {
    body: {
      success: true,
      errors: [],
      result,
      result_info: { page: pageNumber, total_pages: totalPages },
    },
  };
}

const failure = (status: number, message: string) => ({
  status,
  body: { success: false, errors: [{ code: 10_000, message }], result: null },
});

describe("Cloudflare API", () => {
  test("lists a user's accounts from memberships, with the token as a bearer", async () => {
    const { requests, fetchImpl } = recording((url) =>
      url.pathname.endsWith("/memberships")
        ? page([
            { status: "accepted", account: { id: "a1", name: "Acme" } },
            { status: "pending", account: { id: "a2", name: "Invited" } },
            { status: "accepted", account: null },
          ])
        : failure(404, "unexpected")
    );

    const api = cloudflareApi({ type: "token", token: "t0k" }, fetchImpl);

    expect(await api.accounts()).toEqual([{ id: "a1", name: "Acme" }]);
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer t0k");
    expect(requests[0]?.url.origin).toBe("https://api.cloudflare.com");
  });

  test("falls back to /accounts for an account token without memberships", async () => {
    const { requests, fetchImpl } = recording((url) =>
      url.pathname.endsWith("/memberships")
        ? failure(403, "Unauthorized to access requested resource")
        : page([{ id: "a1", name: "Acme" }])
    );

    const api = cloudflareApi(
      { type: "apiKey", key: "k", email: "ada@acme.com" },
      fetchImpl
    );

    expect(await api.accounts()).toEqual([{ id: "a1", name: "Acme" }]);
    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/client/v4/memberships",
      "/client/v4/accounts",
    ]);
    expect(requests[1]?.headers.get("X-Auth-Key")).toBe("k");
    expect(requests[1]?.headers.get("X-Auth-Email")).toBe("ada@acme.com");
  });

  test("reads every page of an account's zones", async () => {
    const { requests, fetchImpl } = recording((url) => {
      const number = Number(url.searchParams.get("page"));

      return page(
        [{ id: `z${number}`, name: `zone${number}.com`, status: "active" }],
        number,
        3
      );
    });

    const api = cloudflareApi({ type: "token", token: "t" }, fetchImpl);

    expect((await api.zones("acct")).map((zone) => zone.name)).toEqual([
      "zone1.com",
      "zone2.com",
      "zone3.com",
    ]);
    expect(requests[0]?.url.searchParams.get("account.id")).toBe("acct");
    expect(requests).toHaveLength(3);
  });

  test("reads a zone's MX records", async () => {
    const { requests, fetchImpl } = recording(() =>
      page([
        {
          name: "acme.com",
          content: "aspmx.l.google.com",
          priority: 1,
          type: "MX",
        },
      ])
    );

    const api = cloudflareApi({ type: "token", token: "t" }, fetchImpl);

    expect(await api.mxRecords("z1")).toEqual([
      { name: "acme.com", content: "aspmx.l.google.com", priority: 1 },
    ]);
    expect(requests[0]?.url.pathname).toBe("/client/v4/zones/z1/dns_records");
    expect(requests[0]?.url.searchParams.get("type")).toBe("MX");
  });

  test("fails with the API's status and message", async () => {
    const { fetchImpl } = recording(() => failure(403, "Authentication error"));
    const api = cloudflareApi({ type: "token", token: "t" }, fetchImpl);
    const error = await api.mxRecords("z1").catch((thrown) => thrown);

    expect(error).toBeInstanceOf(CloudflareApiError);
    expect(error.status).toBe(403);
    expect(error.message).toBe(
      "GET /client/v4/zones/z1/dns_records failed with HTTP 403: Authentication error"
    );
  });
});
