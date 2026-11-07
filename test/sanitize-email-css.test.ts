import { describe, expect, it } from "vitest";
import { rewriteSrcset, sanitizeEmailCss } from "../src/mail/sanitize-email-html";
import { mailRemoteProxyPath } from "../shared/mail-remote";
import {
  assertProxyableRemoteUrl,
  isProxyableRemoteMediaType,
} from "../worker/mail/remote-proxy";

describe("sanitizeEmailCss", () => {
  it("keeps ordinary email layout declarations", () => {
    expect(
      sanitizeEmailCss(
        "display:inline-block;background:#111;color:#fff;padding:12px 24px;border-radius:8px",
      ),
    ).toContain("background:#111");
  });

  it("rewrites remote urls through the worker proxy", () => {
    const cleaned = sanitizeEmailCss(
      "background-image:url(https://cdn.example/logo.png)",
      (url) => mailRemoteProxyPath("mbx_1", url),
    );
    expect(cleaned).toContain("/api/mail/remote?");
    expect(cleaned).toContain(encodeURIComponent("https://cdn.example/logo.png"));
    expect(cleaned).not.toMatch(/url\(["']?https:\/\/cdn\.example/i);
  });

  it("strips scriptable CSS and unrewritable remote urls", () => {
    const cleaned = sanitizeEmailCss(
      "width:100%; background:url(https://tracker.example/pixel.gif); color:expression(alert(1)); @import 'x.css'",
    );
    expect(cleaned).not.toMatch(/https:\/\/tracker/i);
    expect(cleaned).not.toMatch(/expression/i);
    expect(cleaned).not.toMatch(/@import/i);
  });

  it("allows data and cid image urls", () => {
    expect(
      sanitizeEmailCss("background-image:url(data:image/png;base64,aaa)"),
    ).toContain("data:image/png");
    expect(
      sanitizeEmailCss("background-image:url(cid:logo@mail)"),
    ).toContain("cid:logo@mail");
  });
});

describe("rewriteSrcset", () => {
  it("proxies remote candidates and drops everything else", () => {
    const proxy = (url: string) => `/proxy?u=${encodeURIComponent(url)}`;
    expect(rewriteSrcset("https://a.example/1.png 1x, //tracker.example/p.png 2x, /local.png 3x", proxy))
      .toBe(`${proxy("https://a.example/1.png")} 1x`);
  });
});

describe("assertProxyableRemoteUrl", () => {
  it("accepts public https urls", () => {
    expect(assertProxyableRemoteUrl("https://cdn.example/a.png").hostname)
      .toBe("cdn.example");
  });

  it("rejects private and local targets", () => {
    expect(() => assertProxyableRemoteUrl("http://127.0.0.1/x")).toThrow();
    expect(() => assertProxyableRemoteUrl("http://192.168.0.1/x")).toThrow();
    expect(() => assertProxyableRemoteUrl("http://localhost/x")).toThrow();
    expect(() => assertProxyableRemoteUrl("file:///etc/passwd")).toThrow();
  });

  it("rejects IPv4 inside IPv6, local IPv6 and trailing-dot hosts", () => {
    for (const url of [
      "http://[::ffff:127.0.0.1]/x",
      "http://[::ffff:a9fe:a9fe]/x",
      "http://[::127.0.0.1]/x",
      "http://[64:ff9b::7f00:1]/x",
      "http://[2002:7f00:1::]/x",
      "http://[2001:0:7f00:1::]/x",
      "http://[fe80::1]/x",
      "http://[fc00::1]/x",
      "http://localhost./x",
      "http://metadata.google.internal./x",
    ]) expect(() => assertProxyableRemoteUrl(url), url).toThrow();
    expect(assertProxyableRemoteUrl("http://[2606:4700::1111]/x").hostname).toBe("[2606:4700::1111]");
  });
});

describe("isProxyableRemoteMediaType", () => {
  it("accepts every image format requested from remote servers", () => {
    expect(isProxyableRemoteMediaType("image/avif")).toBe(true);
    expect(isProxyableRemoteMediaType("image/apng")).toBe(true);
  });
});
