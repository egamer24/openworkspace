import { describe, expect, it } from "bun:test";

import { clientAddress, ipv6Prefix64 } from "../../worker/lib/rate-limit.ts";

const from = (headers: Record<string, string>) =>
  new Request("https://example.test/", { headers });

describe("rate limit keys", () => {
  it("count the address Cloudflare saw, never a forwarded one", () => {
    expect(
      clientAddress(
        from({
          "cf-connecting-ip": "203.0.113.7",
          "x-forwarded-for": "198.51.100.1",
        })
      )
    ).toBe("203.0.113.7");
    expect(clientAddress(from({ "x-forwarded-for": "198.51.100.1" }))).toBe(
      "unknown"
    );
  });

  it("count an IPv6 address by its /64", () => {
    expect(
      clientAddress(from({ "cf-connecting-ip": "2001:db8:abcd:12:1:2:3:4" }))
    ).toBe("2001:db8:abcd:12::/64");
    expect(
      clientAddress(from({ "cf-connecting-ip": "2001:0db8:abcd:0012:ffff::1" }))
    ).toBe("2001:db8:abcd:12::/64");
    expect(ipv6Prefix64("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipv6Prefix64("::1")).toBe("0:0:0:0::/64");
    expect(ipv6Prefix64("[fe80::1%eth0]")).toBe("fe80:0:0:0::/64");
    expect(ipv6Prefix64("::ffff:192.0.2.1")).toBe("0:0:0:0::/64");
    expect(ipv6Prefix64("2001:db8::1::2")).toBeNull();
    expect(ipv6Prefix64("not:an:address")).toBeNull();
  });
});
