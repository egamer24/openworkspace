import { describe, expect, it } from "bun:test";

import {
  REMOTE_TOKEN_WINDOW_MS,
  signRemoteToken,
  verifyRemoteToken,
} from "@open-workspace/email/worker/mail/remote-token.ts";

const SECRET = "test-secret";
const IMAGE_URL = "https://images.example.net/logo.png";
const NOW = Date.UTC(2026, 10, 8, 13, 0);

describe("remote proxy tokens", () => {
  it("name the user they were issued to, for that mailbox", async () => {
    const token = await signRemoteToken(
      SECRET,
      "usr_1",
      "mbx_1",
      IMAGE_URL,
      NOW
    );

    expect(
      await verifyRemoteToken(SECRET, token, "mbx_1", IMAGE_URL, NOW)
    ).toBe("usr_1");
    expect(
      await verifyRemoteToken(SECRET, token, "mbx_2", IMAGE_URL, NOW)
    ).toBeNull();
    expect(
      await verifyRemoteToken("other-secret", token, "mbx_1", IMAGE_URL, NOW)
    ).toBeNull();
  });

  it("are good for the one image URL they were signed for", async () => {
    const token = await signRemoteToken(
      SECRET,
      "usr_1",
      "mbx_1",
      IMAGE_URL,
      NOW
    );

    expect(
      await verifyRemoteToken(SECRET, token, "mbx_1", IMAGE_URL, NOW)
    ).toBe("usr_1");

    const others = await Promise.all(
      [
        "https://images.example.net/other.png",
        `${IMAGE_URL}?x=1`,
        "http://127.0.0.1/secret.png",
      ].map((other) => verifyRemoteToken(SECRET, token, "mbx_1", other, NOW))
    );

    expect(others).toEqual([null, null, null]);
  });

  it("are the same within a window and last one to two windows", async () => {
    const windowStart =
      Math.floor(NOW / REMOTE_TOKEN_WINDOW_MS) * REMOTE_TOKEN_WINDOW_MS;

    const first = await signRemoteToken(
      SECRET,
      "usr_1",
      "mbx_1",
      IMAGE_URL,
      windowStart
    );

    const last = await signRemoteToken(
      SECRET,
      "usr_1",
      "mbx_1",
      IMAGE_URL,
      windowStart + REMOTE_TOKEN_WINDOW_MS - 1
    );

    expect(last).toBe(first);
    const expiresAt = windowStart + 2 * REMOTE_TOKEN_WINDOW_MS;
    expect(
      await verifyRemoteToken(SECRET, first, "mbx_1", IMAGE_URL, expiresAt - 1)
    ).toBe("usr_1");
    expect(
      await verifyRemoteToken(SECRET, first, "mbx_1", IMAGE_URL, expiresAt)
    ).toBeNull();

    const next = await signRemoteToken(
      SECRET,
      "usr_1",
      "mbx_1",
      IMAGE_URL,
      windowStart + REMOTE_TOKEN_WINDOW_MS
    );

    expect(next).not.toBe(first);
  });

  it("reject tampering", async () => {
    const token = await signRemoteToken(
      SECRET,
      "usr_1",
      "mbx_1",
      IMAGE_URL,
      NOW
    );

    const [, expiry = "", signature] = token.split(".");
    expect(
      await verifyRemoteToken(
        SECRET,
        `usr_2.${expiry}.${signature}`,
        "mbx_1",
        IMAGE_URL,
        NOW
      )
    ).toBeNull();

    const later = (
      Number.parseInt(expiry, 36) + REMOTE_TOKEN_WINDOW_MS
    ).toString(36);

    expect(
      await verifyRemoteToken(
        SECRET,
        `usr_1.${later}.${signature}`,
        "mbx_1",
        IMAGE_URL,
        NOW
      )
    ).toBeNull();
    expect(
      await verifyRemoteToken(
        SECRET,
        `usr_1.${expiry}.AAAA`,
        "mbx_1",
        IMAGE_URL,
        NOW
      )
    ).toBeNull();

    const malformed = ["", "usr_1", "usr_1.x", ".a.b", "usr_1.zz.!!"];

    expect(
      await Promise.all(
        malformed.map((value) =>
          verifyRemoteToken(SECRET, value, "mbx_1", IMAGE_URL, NOW)
        )
      )
    ).toEqual(malformed.map(() => null));
  });
});

describe("remote image targets", () => {
  it("refuse private and special addresses in every spelling the URL parser normalizes", async () => {
    const { assertProxyableRemoteUrl } =
      await import("@open-workspace/email/worker/mail/remote-proxy.ts");

    for (const url of [
      "http://127.0.0.1/a.png",
      "http://2130706433/a.png",
      "http://0x7f.1/a.png",
      "http://[::1]/a.png",
      "http://[::]/a.png",
      "http://[::ffff:7f00:1]/a.png",
      "http://[::ffff:127.0.0.1]/a.png",
      "http://[::ffff:a9fe:a9fe]/a.png",
      "http://[::ffff:0:a00:1]/a.png",
      "http://[::7f00:1]/a.png",
      "http://[64:ff9b::a9fe:a9fe]/a.png",
      "http://[2002:c0a8:101::1]/a.png",
      "http://[fd00::1]/a.png",
      "http://[fe80::1]/a.png",
      "http://[ff02::1]/a.png",
      "http://169.254.169.254/latest/meta-data",
      "http://100.64.0.1/a.png",
      "http://198.18.0.1/a.png",
      "http://224.0.0.1/a.png",
      "http://localhost./a.png",
      "http://metadata.google.internal/a.png",
    ]) {
      expect(() => assertProxyableRemoteUrl(url), url).toThrow(
        "Remote host is not allowed"
      );
    }

    for (const url of [
      "https://images.example.net/a.png",
      "http://93.184.216.34/a.png",
      "http://[2606:4700::1111]/a.png",
      "http://[64:ff9b::5db8:d822]/a.png",
    ]) {
      expect(assertProxyableRemoteUrl(url).toString()).toBe(
        new URL(url).toString()
      );
    }
  });
});

describe("remote image URLs in a message", () => {
  it("are found as the browser reads them", async () => {
    const { remoteImageUrls } =
      await import("@open-workspace/email/shared/mail-remote.ts");

    const urls = remoteImageUrls(
      [
        '<img src="https://a.example/x.png?a=1&amp;b=2">',
        '<img srcset="https://b.example/1x.png 1x, https://b.example/2x.png 2x">',
        "<div style=\"background:url('https://c.example/bg.jpg')\"></div>",
        "<p>Visit https://d.example/page.</p>",
      ].join("")
    );

    expect(urls).toContain("https://a.example/x.png?a=1&b=2");
    expect(urls).toContain("https://b.example/1x.png");
    expect(urls).toContain("https://b.example/2x.png");
    expect(urls).toContain("https://c.example/bg.jpg");
    expect(urls).toContain("https://d.example/page");
  });
});
