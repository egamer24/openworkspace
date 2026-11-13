import { describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import {
  dkimSignatures,
  dkimSigningDomains,
  ipKind,
  mimeStructure,
  originalHeaderValues,
  originalSenderDetails,
  receivedHops,
  transitTime,
} from "@open-workspace/email/src/mail/original-message.ts";

import githubHeaders from "../fixtures/headers/github.txt" with { type: "text" };
import namecheap from "../fixtures/headers/namecheap.txt" with { type: "text" };
import playstation from "../fixtures/headers/playstation.txt" with { type: "text" };

describe("original message headers", () => {
  it("unfolds headers and extracts unique DKIM signing domains", () => {
    const raw = [
      "From: sender@example.com",
      "DKIM-Signature: v=1; a=rsa-sha256;",
      " d=mail.example.com; s=one; b=abc",
      "DKIM-Signature: v=1; d=EXAMPLE.NET; s=two; b=def",
      "DKIM-Signature: v=1; d=mail.example.com; s=three; b=ghi",
      "",
      "DKIM-Signature: d=body.invalid",
    ].join("\r\n");

    expect(originalHeaderValues(raw, "dkim-signature")).toHaveLength(3);
    expect(dkimSigningDomains(raw)).toEqual([
      "mail.example.com",
      "example.net",
    ]);
  });
});

describe("original message details", () => {
  const raw = [
    "Return-Path: <bounce@mail.example.com>",
    "Received: from out.example.com (out.example.com [198.51.100.7])",
    "\tby mx.demo.example with ESMTPS (version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384);",
    "\tTue, 27 Oct 2026 10:00:05 +0000",
    "Received: from app-7 ([10.0.4.12]) by out.example.com with ESMTP id abc;",
    "\tTue, 27 Oct 2026 10:00:02 +0000",
    "DKIM-Signature: v=1; a=rsa-sha256; d=Example.com; s=mail; h=from:to:subject; b=x",
    "List-Unsubscribe: <https://example.com/u>",
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    "X-Mailer: Campaigner 4.2",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "--outer",
    'Content-Type: multipart/alternative; boundary="inner"',
    "",
    "--inner",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello",
    "--inner",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "<p>Hello</p>",
    "--inner--",
    "--outer",
    'Content-Type: application/pdf; name="notes.pdf"',
    'Content-Disposition: attachment; filename="notes.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0=",
    "--outer--",
    "",
  ].join("\r\n");

  it("orders Received hops from the sender and measures each delay", () => {
    const hops = receivedHops(raw);
    expect(
      hops.map((hop) => [hop.from, hop.ip, hop.by, hop.protocol, hop.tls])
    ).toEqual([
      ["app-7", "10.0.4.12", "out.example.com", "ESMTP", null],
      [
        "out.example.com",
        "198.51.100.7",
        "mx.demo.example",
        "ESMTPS",
        "TLS 1.3",
      ],
    ]);
    expect(hops.map((hop) => hop.delayMs)).toEqual([null, 3000]);
  });

  it("classifies addresses and finds the external sender", () => {
    expect(ipKind("10.0.4.12")).toBe("private");
    expect(ipKind("198.51.100.7")).toBe("reserved");
    expect(ipKind("8.8.8.8")).toBe("public");
    expect(ipKind("::1")).toBe("loopback");
    // Without Cloudflare's trusted hop, no sender-reported hop names the sending IP.
    expect(originalSenderDetails(raw)).toEqual({
      returnPath: "bounce@mail.example.com",
      senderIp: null,
      mailer: "Campaigner 4.2",
      listId: null,
      precedence: null,
    });
  });

  it("reads DKIM tags and the MIME tree", () => {
    expect(dkimSignatures(raw)).toEqual([
      {
        domain: "example.com",
        selector: "mail",
        algorithm: "rsa-sha256",
        signedHeaders: ["from", "to", "subject"],
      },
    ]);
    expect(
      mimeStructure(raw).map((part) => [
        part.depth,
        part.contentType,
        part.filename,
      ])
    ).toEqual([
      [0, "multipart/mixed", null],
      [1, "multipart/alternative", null],
      [2, "text/plain", null],
      [2, "text/html", null],
      [1, "application/pdf", "notes.pdf"],
    ]);
  });

  it("reads Cloudflare Email Routing hops with a bare IP", () => {
    const hops = receivedHops(
      [
        "Received: from v535.v5be21903.use4.send.mailgun.net (159.112.243.35)",
        "        by cloudflare-email.net (cloudflare) id gUhc7plbeEX3",
        "        for <me@example.com>; Fri, 23 Oct 2026 22:06:06 +0000",
        "Received: from mail.example.org (2a00:1450:4864:20::62a) by mx.example.net with ESMTPS; Fri, 23 Oct 2026 22:06:05 +0000",
        "",
      ].join("\r\n")
    );

    expect(hops.map((hop) => [hop.from, hop.ip, hop.by, hop.trusted])).toEqual([
      ["mail.example.org", "2a00:1450:4864:20::62a", "mx.example.net", false],
      [
        "v535.v5be21903.use4.send.mailgun.net",
        "159.112.243.35",
        "cloudflare-email.net",
        true,
      ],
    ]);
  });
});

describe("Received parser", () => {
  const hop = (value: string) =>
    required(receivedHops(`Received: ${value}\r\n`)[0], "a Received hop");

  it("reads SendGrid hops without a `;` before the date, including Go timestamps", () => {
    const hops = receivedHops(namecheap);
    expect(
      hops.map((item) => [
        item.from,
        item.by,
        item.protocol,
        item.at?.toISOString() ?? null,
      ])
    ).toEqual([
      ["MTg4NTY2MDQ", "geopod-ismtpd-16", "HTTP", "2026-10-29T15:24:22.000Z"],
      [null, "recvd-5fbf9c6c9f-8g6m9", "SMTP", "2026-10-29T15:24:22.000Z"],
      [
        "o4.mailservice.namecheap.com",
        "cloudflare-email.net",
        null,
        "2026-10-29T15:24:22.000Z",
      ],
    ]);
    expect(hops.map((item) => item.delayMs)).toEqual([null, 0, 0]);
    expect(hops.map((item) => item.trusted)).toEqual([false, false, true]);
    expect(hops[2]?.ip).toBe("167.89.64.97");
    expect(hops[0]?.ip).toBeNull();
  });

  it("strips a comment after the date and measures from the nearest dated hop", () => {
    const hops = receivedHops(playstation);
    expect(hops[0]?.at?.toISOString()).toBe("2026-10-27T16:30:43.000Z");
    expect(hops[0]?.id).toBe("hs38r639mjco");
    const github = receivedHops(githubHeaders);
    expect(
      github.map((item) => [
        item.ip,
        item.reverseDns,
        item.protocol,
        item.delayMs,
      ])
    ).toEqual([
      [
        "10.154.15.73",
        "hubbernetes-node-25b1c88.gc-cus-02.github.net",
        "ESMTPA",
        null,
      ],
      ["192.30.252.194", null, null, 0],
    ]);
  });

  it("takes the IP from the from-clause only and validates it", () => {
    const microsoft = hop(
      "from AM9PR04MB1234.eurprd04.prod.outlook.com (2603:10a6:20b:2c4:0:0:0:12) by AS8PR04MB5678.eurprd04.prod.outlook.com (2603:10a6:20b:3f::9) with Microsoft SMTP Server (version=TLS1_2, cipher=TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384) id 15.20.7633.30; Fri, 23 Oct 2026 22:06:05 +0000"
    );

    expect([microsoft.ip, microsoft.protocol, microsoft.tls]).toEqual([
      "2603:10a6:20b:2c4::12",
      "Microsoft SMTP Server",
      "TLS 1.2",
    ]);

    const byOnly = hop(
      "from relay.example (relay.example) by mx.example.net ([192.0.2.55]) with ESMTP; Fri, 23 Oct 2026 22:06:05 +0000"
    );

    expect(byOnly.ip).toBeNull();

    const invalid = hop(
      "from bogus.example (bogus.example [300.1.2.3]) by mx.example.net; Fri, 23 Oct 2026 22:06:05 +0000"
    );

    expect(invalid.ip).toBeNull();

    const exim = hop(
      "from [192.0.2.1] (helo=host.example) by mx.example.net with esmtps (TLS1.3) tls TLS_AES_256_GCM_SHA384 (Exim 4.97) (envelope-from <a@b.example>) id 1rX-000a-2Q for r@example.com; Fri, 23 Oct 2026 22:06:05 +0000"
    );

    expect([exim.from, exim.ip, exim.protocol, exim.tls, exim.id]).toEqual([
      "host.example",
      "192.0.2.1",
      "esmtps",
      "TLS 1.3",
      "1rX-000a-2Q",
    ]);

    const gmail = hop(
      "from mail-sor-f41.google.com (mail-sor-f41.google.com. [209.85.220.41]) by mx.google.com with SMTPS id a640c for <r@example.com> (Google Transport Security); Fri, 23 Oct 2026 22:06:05 -0700 (PDT)"
    );

    expect([
      gmail.ip,
      gmail.reverseDns,
      gmail.tls,
      gmail.at?.toISOString(),
    ]).toEqual(["209.85.220.41", null, "TLS", "2026-10-24T05:06:05.000Z"]);
  });

  it("absorbs small clock skew and drops garbage negative delays", () => {
    const hops = receivedHops(
      [
        "Received: from d by e; Thu, 22 Oct 2026 10:00:00 +0000",
        "Received: from c by d; Fri, 23 Oct 2026 22:05:00 +0000",
        "Received: from b by c; Fri, 23 Oct 2026 21:57:00 +0000",
        "Received: from a by b; Fri, 23 Oct 2026 22:00:00 +0000",
        "",
      ].join("\r\n")
    );

    expect(hops.map((item) => [item.delayMs, item.skewMs])).toEqual([
      [null, null],
      [0, -180_000],
      [300_000, null],
      [null, null],
    ]);
  });

  it("derives Return-Path and the sending IP from trusted data", () => {
    expect(
      originalSenderDetails(namecheap, {
        remoteIp: "167.89.64.97",
        envelopeFrom: "bounces@mailserviceemailout1.namecheap.com",
      })
    ).toMatchObject({
      returnPath: "bounces@mailserviceemailout1.namecheap.com",
      senderIp: "167.89.64.97",
    });
    expect(originalSenderDetails(githubHeaders).senderIp).toBe(
      "192.30.252.194"
    );
    expect(transitTime(githubHeaders, receivedHops(githubHeaders))).toEqual({
      ms: 0,
      basis: "hops",
    });
  });
});
