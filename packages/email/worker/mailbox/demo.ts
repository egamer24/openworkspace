import { required } from "@open-workspace/core/shared";

import type { AuthResult, DmarcPolicy } from "../../shared/mail-authentication";
import type {
  SenderIntel,
  SpamhausListing,
} from "../../shared/mail-sender-intel";
import { inboundHeaderMetadata } from "../mail/auth-headers";
import { bimiObjectKey } from "../mail/bimi";
import { DEMO_UNSUBSCRIBE_HOST } from "../mail/demo-routes";
import {
  marginNotesHtml,
  canvaslyInvoiceHtml,
  hirelineHtml,
} from "./demo-html";
import type { EmailAiClassification, MailAddress } from "./model";
import type { NewEmail, NewFolder } from "./schema";

type DemoInput = {
  id: string;
  conversationId: string;
  messageId: string;
  direction?: "incoming" | "outgoing";
  from: MailAddress;
  replyTo?: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  subject: string;
  preview: string;
  body: string;
  ageMs: number;
  references?: string[];
  html?: string;
  /** Seeds a raw original with stored authentication and AI check results. */
  checks?: DemoChecks;
};

/**
 * What Cloudflare Email Routing would have reported for the message. The raw
 * original is rendered with Cloudflare's header block from this, and the
 * stored results are parsed back out of it by the production parser.
 */
type DemoAuthentication = {
  /** Connecting IP (documentation ranges only). */
  ip: string;
  helo: string;
  /** SMTP MAIL FROM. */
  mailFrom: string;
  spf: AuthResult;
  spfHelo: AuthResult;
  dkim: {
    domain: string;
    selector: string;
    result: AuthResult;
    signs: string[];
  }[];
  dmarc: AuthResult;
  policy: DmarcPolicy | null;
  spamScore: number;
  /** Delivered through a forwarder that sealed an ARC set first. */
  forwardedVia?: {
    sealer: string;
    authservId: string;
    helo: string;
    ip: string;
  };
};

/**
 * Pre-computed sender intelligence. Demo IPs are documentation ranges, so
 * live DNS would find nothing; the rows carry what a real lookup would show.
 * ASNs 64496–64511 are reserved for documentation.
 */
type DemoIntel = {
  ptr: string | null;
  fcrdns?: boolean;
  generic?: boolean;
  asn: number;
  asName: string;
  prefix: string;
  country: string;
  registry?: string;
  /** As if a Spamhaus DQS key were configured. */
  spamhaus?: {
    zen?: Pick<SpamhausListing, "code" | "list" | "severity">[];
    dbl?: { domain: string; code: string; list: string }[];
    domains: string[];
  };
  /** The From domain serves the demo BIMI logo seeded next to the rows. */
  bimi?: boolean;
};

type DemoChecks = {
  /** Bulk senders connect straight to the MX without an internal hop. */
  direct?: boolean;
  intel?: DemoIntel;
  mailer?: string;
  list?: { id: string };
  authentication: DemoAuthentication;
  ai: Pick<
    EmailAiClassification,
    "spam" | "spamConfidence" | "folderId" | "folderConfidence" | "reason"
  >;
};

/** R2 keys for demo message bodies; the objects are seeded next to the rows. */
function demoHtmlKey(id: string) {
  return `demo/messages/${id}/body.html`;
}

function demoRawKey(id: string) {
  return `demo/messages/${id}/original.eml`;
}

function mimeAddress(address: MailAddress) {
  return address.name
    ? `"${address.name}" <${address.address}>`
    : address.address;
}

function demoToken(seed: string, length: number) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  let hash = 2_166_136_261;

  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16_777_619) >>> 0;
  }

  let token = "";

  while (token.length < length) {
    // xorshift32 keeps the demo signatures stable between seeds and renders.
    hash ^= hash << 13;
    hash ^= hash >>> 17;
    hash ^= hash << 5;
    hash >>>= 0;
    token += alphabet[hash % alphabet.length];
  }

  return token;
}

function spfComment(result: AuthResult, identity: string, ip: string) {
  if (result === "pass") {
    return `domain of ${identity} designates ${ip} as permitted sender`;
  }

  if (result === "none") return `no SPF records found for ${identity}`;

  if (result === "softfail") {
    return `domain of transitioning ${identity} does not designate ${ip} as permitted sender`;
  }

  return `domain of ${identity} does not designate ${ip} as permitted sender`;
}

/** `Name: authserv-id;` followed by one folded line per result. */
function folded(prefix: string, parts: string[]) {
  return `${prefix};\r\n\t${parts.join(";\r\n\t")}`;
}

/** Cloudflare's prepended header block, topmost first, as seen on production mail. */
function cloudflareHeaders(
  input: DemoInput,
  auth: DemoAuthentication,
  at: (offsetMs: number) => string
) {
  const fromDomain = input.from.address.split("@")[1] ?? "invalid";
  const recipient = input.to[0]?.address ?? "user@demo.example";
  const instance = auth.forwardedVia ? 2 : 1;

  const results = [
    ...(auth.dkim.length
      ? auth.dkim.map(
          (dkim) =>
            `dkim=${dkim.result} header.d=${dkim.domain} header.s=${dkim.selector} header.b=${demoToken(`${input.id}${dkim.domain}`, 8)}`
        )
      : ["dkim=none"]),
    `dmarc=${auth.dmarc} header.from=${fromDomain}${auth.policy ? ` policy.dmarc=${auth.policy}` : ""}`,
    `spf=${auth.spfHelo} (mx.cloudflare.net: ${spfComment(auth.spfHelo, `postmaster@${auth.helo}`, auth.ip)}) smtp.helo=${auth.helo}`,
    `spf=${auth.spf} (mx.cloudflare.net: ${spfComment(auth.spf, auth.mailFrom, auth.ip)}) smtp.mailfrom=${auth.mailFrom}`,
    `arc=${auth.forwardedVia ? "pass" : "none"} smtp.remote-ip=${auth.ip}`,
  ];

  return [
    `Received: from ${auth.helo} (${auth.ip})`,
    `\tby cloudflare-email.net (cloudflare) id ${demoToken(input.id, 12)}`,
    `\tfor <${recipient}>; ${at(0)}`,
    `ARC-Seal: i=${instance}; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=${instance > 1 ? "pass" : "none"};`,
    `\tb=${demoToken(`${input.id}seal`, 64)}`,
    `ARC-Message-Signature: i=${instance}; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; c=relaxed/relaxed;`,
    "\th=To:Subject:From:Date:from:reply-to:cc:in-reply-to:references:list-id; bh=",
    `\t${demoToken(`${input.id}bh`, 43)}=; b=${demoToken(`${input.id}ams`, 64)}`,
    folded(
      `ARC-Authentication-Results: i=${instance}; mx.cloudflare.net`,
      results
    ),
    `Received-SPF: ${auth.spf} (mx.cloudflare.net: ${spfComment(auth.spf, auth.mailFrom, auth.ip)})`,
    `\treceiver=mx.cloudflare.net; client-ip=${auth.ip}; envelope-from="${auth.mailFrom}"; helo=${auth.helo};`,
    folded("Authentication-Results: mx.cloudflare.net", results),
    `X-CF-SpamH-Score: ${auth.spamScore}`,
  ];
}

function forwarderHeaders(
  input: DemoInput,
  auth: DemoAuthentication,
  at: (offsetMs: number) => string
) {
  const via = auth.forwardedVia;

  if (!via) return [];
  const fromDomain = input.from.address.split("@")[1] ?? "invalid";
  const original = auth.dkim.find((dkim) => dkim.domain === fromDomain);

  return [
    `ARC-Seal: i=1; a=rsa-sha256; t=1793000000; cv=none; d=${via.sealer}; s=arc-20240605;`,
    `\tb=${demoToken(`${input.id}upseal`, 64)}`,
    `ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=${via.sealer}; s=arc-20240605;`,
    `\th=to:subject:message-id:date:from:mime-version; bh=${demoToken(`${input.id}upbh`, 43)}=; b=${demoToken(`${input.id}upams`, 48)}`,
    folded(`ARC-Authentication-Results: i=1; ${via.authservId}`, [
      `dkim=pass header.i=@${fromDomain} header.s=${original?.selector ?? "mail"}`,
      `spf=pass (${via.authservId}: domain of ${input.from.address} designates ${via.ip} as permitted sender) smtp.mailfrom=${input.from.address}`,
      `dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=${fromDomain}`,
    ]),
    `Received: by 2001:db8:4864:20::62a with SMTP id ${demoToken(`${input.id}fw`, 10)};`,
    `\t${at(-2000)}`,
    folded(`Authentication-Results: ${via.authservId}`, [
      `dkim=pass header.i=@${fromDomain} header.s=${original?.selector ?? "mail"}`,
      `spf=pass smtp.mailfrom=${input.from.address}`,
      `dmarc=pass header.from=${fromDomain}`,
    ]),
    `Received: from ${via.helo} (${via.helo} [${via.ip}])`,
    `\tby ${via.authservId} with ESMTPS id ${demoToken(`${input.id}mx`, 10)}`,
    `\tfor <${input.to[0]?.address ?? "user@demo.example"}>`,
    `\t(Google Transport Security); ${at(-3000)}`,
  ];
}

function dkimSignatureHeaders(input: DemoInput, auth: DemoAuthentication) {
  return auth.dkim.flatMap((dkim) => [
    `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${dkim.domain}; s=${dkim.selector};`,
    `\th=${dkim.signs.join(":")};`,
    `\tbh=${demoToken(`${input.id}${dkim.domain}bh`, 43)}=;`,
    `\tb=${demoToken(`${input.id}${dkim.domain}`, 8)}${demoToken(`${input.id}${dkim.domain}sig`, 56)}`,
  ]);
}

/** A plausible RFC 5322 original for the "Show original" view. */
function demoRawMime(input: DemoInput, now: number) {
  const date = new Date(now - input.ageMs)
    .toUTCString()
    .replace("GMT", "+0000");

  const at = (offsetMs: number) =>
    new Date(now - input.ageMs + offsetMs)
      .toUTCString()
      .replace("GMT", "+0000");

  const { checks } = input;
  const auth = checks?.authentication;

  const senderHops =
    !auth || checks?.direct || auth.forwardedVia
      ? []
      : [
          "Received: from app-3.internal ([10.12.4.8])",
          `\tby ${auth.helo} with ESMTPSA id ${input.id}-out; ${at(-4000)}`,
        ];

  const unsubscribeId = demoToken(`${input.id}unsubscribe`, 16).replaceAll(
    /[+/]/gu,
    "x"
  );

  const headers = [
    ...(auth ? cloudflareHeaders(input, auth, at) : []),
    ...(auth ? forwarderHeaders(input, auth, at) : []),
    ...(auth ? dkimSignatureHeaders(input, auth) : []),
    ...senderHops,
    `From: ${mimeAddress(input.from)}`,
    ...(input.replyTo ? [`Reply-To: ${mimeAddress(input.replyTo)}`] : []),
    `To: ${input.to.map(mimeAddress).join(", ")}`,
    ...(input.cc?.length
      ? [`Cc: ${input.cc.map(mimeAddress).join(", ")}`]
      : []),
    `Subject: ${input.subject}`,
    `Date: ${date}`,
    `Message-ID: ${input.messageId}`,
    ...(checks?.mailer ? [`X-Mailer: ${checks.mailer}`] : []),
    ...(checks?.list
      ? [
          `List-Id: <${checks.list.id}>`,
          // A demo-local endpoint answered in-process, never the real sender.
          `List-Unsubscribe: <https://${DEMO_UNSUBSCRIBE_HOST}/one-click/${unsubscribeId}>, <mailto:unsubscribe+${unsubscribeId}@${DEMO_UNSUBSCRIBE_HOST}?subject=unsubscribe>`,
          "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
          "Precedence: bulk",
        ]
      : []),
    "MIME-Version: 1.0",
  ];

  const text = input.body.replaceAll("\n", "\r\n");

  if (!input.html) {
    return [
      ...headers,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      text,
      "",
    ].join("\r\n");
  }

  const boundary = `demo-${input.id}`;

  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    input.html,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function demoSenderIntel(
  input: DemoInput,
  checkedAt: number
): SenderIntel | null {
  const { checks } = input;
  const intel = checks?.intel;

  if (!checks || !intel) return null;
  const { ip } = checks.authentication;
  const fromDomain = input.from.address.split("@")[1] ?? "invalid";
  const fcrdns = intel.ptr ? (intel.fcrdns ?? true) : false;
  const helo = checks.authentication.helo.toLocaleLowerCase();

  return {
    version: 1,
    source: "demo",
    checkedAt,
    ip,
    ipVersion: ip.includes(":") ? 6 : 4,
    ptr: {
      status: intel.ptr ? "ok" : "nxdomain",
      names: intel.ptr ? [intel.ptr] : [],
      confirmed: intel.ptr && fcrdns ? intel.ptr : null,
      fcrdns,
      generic: intel.ptr ? (intel.generic ?? false) : null,
    },
    heloMatchesPtr: intel.ptr
      ? helo === intel.ptr ||
        helo.split(".").slice(-2).join(".") ===
          intel.ptr.split(".").slice(-2).join(".")
      : null,
    network: {
      status: "ok",
      asn: intel.asn,
      asName: intel.asName,
      prefix: intel.prefix,
      country: intel.country,
      registry: intel.registry ?? "arin",
    },
    spamhaus: intel.spamhaus
      ? {
          zen: {
            status: "ok",
            error: null,
            listings: (intel.spamhaus.zen ?? []).map((listing) => ({
              zone: "zen",
              target: ip,
              ...listing,
            })),
          },
          dbl: {
            status: "ok",
            error: null,
            domains: intel.spamhaus.domains,
            listings: (intel.spamhaus.dbl ?? []).map((listing) => ({
              zone: "dbl",
              target: listing.domain,
              code: listing.code,
              list: listing.list,
              severity: "abuse",
            })),
          },
        }
      : null,
    bimi: intel.bimi
      ? { domain: fromDomain, status: "ok", reason: null }
      : null,
  };
}

/** The domain of a demo address; every one has one. */
function demoDomain(address: string) {
  return required(address.split("@")[1], `${address} has a domain`);
}

function email(input: DemoInput, now: number): NewEmail {
  const timelineAt = new Date(now - input.ageMs);
  const outgoing = input.direction === "outgoing";

  const message: NewEmail = {
    id: input.id,
    conversationId: input.conversationId,
    direction: outgoing ? "outgoing" : "incoming",
    messageIdHeader: input.messageId,
    inReplyToJson: input.references?.slice(-1) ?? [],
    referencesJson: input.references ?? [],
    fromJson: [input.from],
    replyToJson: input.replyTo ? [input.replyTo] : [],
    listId: input.checks?.list?.id ?? null,
    toJson: input.to,
    ccJson: input.cc ?? [],
    subject: input.subject,
    preview: input.preview,
    bodyText: input.body,
    bodyHtmlR2Key: input.html ? demoHtmlKey(input.id) : null,
    rawMimeR2Key: input.checks ? demoRawKey(input.id) : null,
    envelopeFrom: input.checks?.authentication.mailFrom ?? null,
    envelopeTo: outgoing ? null : (input.to[0]?.address ?? null),
    senderIntelJson: demoSenderIntel(input, timelineAt.getTime() + 1500),
    aiClassificationJson: input.checks
      ? {
          source: "ai",
          model: "openai/gpt-6-luna",
          processedAt: timelineAt.getTime() + 2000,
          ...input.checks.ai,
        }
      : null,
    timelineAt,
    transportState: outgoing ? "submitted" : "received",
    deliveryStatusJson: outgoing
      ? input.to.map((recipient, index) => ({
          recipient: recipient.address,
          status: "delivered" as const,
          eventId: `demo_${input.id}_${index}`,
          eventAt: timelineAt.getTime() + 1500,
          smtpCode: "250",
          detail: null,
        }))
      : [],
  };

  if (input.checks) {
    // Parsed by the production parser from the same original seeded into R2.
    Object.assign(
      message,
      inboundHeaderMetadata({
        rawHeaders: demoRawMime(input, now),
        fromAddress: input.from.address,
        envelopeFrom: input.checks.authentication.mailFrom,
        now: timelineAt.getTime() + 1000,
      })
    );
  }

  return message;
}

const sam = { address: "sam@demo.example", name: "Sam Brooks" };
const support = { address: "support@demo.example", name: "Customer care" };

function demoInputs(mailboxId: string): DemoInput[] {
  if (mailboxId === "mbx_demo_personal") {
    return [
      {
        id: "msg_demo_01",
        conversationId: "conv_demo_launch",
        messageId: "<launch@lumen.example>",
        from: { address: "kai@lumen.example", name: "Kai Lindqvist" },
        to: [sam],
        subject: "The craft behind fast software",
        preview:
          "I kept thinking about our conversation on speed and quality. The teams that move fastest rarely skip the details.",
        body: "Hey Sam,\n\nI kept thinking about our conversation on speed and quality. The teams that move fastest rarely skip the details — they make the right details easier to see.\n\nHere are the notes from our design review and the three decisions we should make this week.\n\nKai",
        ageMs: 540_000,
      },
      {
        id: "msg_demo_07",
        conversationId: "conv_demo_launch",
        messageId: "<reply@openworkspace.demo>",
        direction: "outgoing",
        from: sam,
        to: [{ address: "kai@lumen.example", name: "Kai Lindqvist" }],
        subject: "Re: The craft behind fast software",
        preview:
          "That framing is exactly right. I turned the decisions into a smaller review doc.",
        body: "That framing is exactly right. I turned the decisions into a smaller review doc and will send the final version tomorrow.\n\nThanks,\nSam",
        ageMs: 180_000,
        references: ["<launch@lumen.example>"],
      },
      {
        id: "msg_demo_02",
        conversationId: "conv_demo_edgeworks",
        messageId: "<workers@edgeworks.example>",
        from: { address: "jessica@edgeworks.example", name: "Jessica Lee" },
        to: [sam],
        cc: [{ address: "maya@demo.example", name: "Maya Chen" }],
        subject: "Your Workers architecture review",
        preview:
          "The per-mailbox SQLite design looks solid. Keeping raw MIME in R2 leaves the mailbox database focused.",
        body: "Hi Sam,\n\nThe per-mailbox SQLite design looks solid. Keeping raw MIME in R2 leaves the mailbox database focused on RFC metadata and conversation state.\n\nI left a few notes on retries and idempotency below.\n\nBest,\nJessica",
        ageMs: 4_200_000,
        checks: {
          mailer: "Apple Mail (2.3826.400)",
          intel: {
            ptr: "mail-yw1-f42.google.com",
            asn: 15_169,
            asName: "Google LLC",
            prefix: "198.51.100.0/24",
            country: "US",
          },
          authentication: {
            ip: "198.51.100.42",
            helo: "smtp-out.edgeworks.example",
            mailFrom: "jessica@edgeworks.example",
            spf: "pass",
            spfHelo: "none",
            dkim: [
              {
                domain: "edgeworks.example",
                selector: "google",
                result: "pass",
                signs: ["from", "to", "cc", "subject", "date", "message-id"],
              },
            ],
            dmarc: "pass",
            policy: "reject",
            spamScore: 0,
          },
          ai: {
            spam: false,
            spamConfidence: 0.02,
            folderId: null,
            folderConfidence: 0.12,
            reason:
              "Personal work correspondence from a known contact replying to an architecture review.",
          },
        },
      },
      {
        id: "msg_demo_03",
        conversationId: "conv_demo_maya",
        messageId: "<maya-update@demo>",
        from: { address: "maya@demo.example", name: "Maya Chen" },
        to: [sam],
        subject: "Friday launch checklist",
        preview:
          "I grouped the remaining work into launch blockers and follow-ups. We are down to four real blockers.",
        body: "I grouped the remaining work into launch blockers and follow-ups. We are down to four real blockers:\n\n1. Verify catch-all routing\n2. Run mobile QA\n3. Confirm outbound domain\n4. Write the setup guide\n\nEverything else can follow next week.",
        ageMs: 86_400_000,
      },
      {
        id: "msg_demo_04",
        conversationId: "conv_demo_vertex",
        messageId: "<design@vertex.example>",
        from: { address: "rafael@vertex.example", name: "Rafael Ortiz" },
        to: [sam],
        subject: "Re: interaction details",
        preview:
          "The reduced motion version feels right now. I would keep the mailbox transition almost instant.",
        body: "The reduced-motion build is ready for review. I shortened the mailbox transition and kept the composer animation subtle.\n\nThe updated interaction notes are attached to the ticket.",
        ageMs: 172_800_000,
      },
      {
        id: "msg_demo_05",
        conversationId: "conv_demo_weekly",
        messageId: "<weekly@paper.demo>",
        from: { address: "digest@margin-notes.example", name: "Margin Notes" },
        to: [sam],
        subject: "Issue 341 — tools for thought",
        preview:
          "A small collection of thoughtful products, strange links, and ideas worth carrying into the weekend.",
        body: "A small collection of thoughtful products, strange links, and ideas worth carrying into the weekend.\n\nThis week: humane inboxes, local-first databases, and why fast tools feel calm.",
        ageMs: 259_200_000,
        html: marginNotesHtml,
        checks: {
          mailer: "Campaigner 4.2",
          intel: {
            ptr: "mta-7.campaigner-mail.example",
            asn: 64_500,
            asName: "Campaigner Mail Services",
            prefix: "203.0.113.0/25",
            country: "CA",
          },
          list: { id: "weekly.margin-notes.example" },
          authentication: {
            ip: "203.0.113.24",
            helo: "mta-7.campaigner-mail.example",
            mailFrom: "bounce-341-8812@mail.margin-notes.example",
            spf: "pass",
            spfHelo: "none",
            dkim: [
              {
                domain: "margin-notes.example",
                selector: "cm1",
                result: "pass",
                signs: [
                  "from",
                  "to",
                  "subject",
                  "date",
                  "message-id",
                  "list-id",
                  "list-unsubscribe",
                  "list-unsubscribe-post",
                ],
              },
              {
                domain: "campaigner-mail.example",
                selector: "esp",
                result: "pass",
                signs: ["from", "to", "subject", "date"],
              },
            ],
            dmarc: "pass",
            policy: "quarantine",
            spamScore: 1,
          },
          ai: {
            spam: false,
            spamConfidence: 0.07,
            folderId: null,
            folderConfidence: 0.22,
            reason:
              "Newsletter you subscribed to, with a working unsubscribe link and consistent sender.",
          },
        },
      },
      {
        id: "msg_demo_06",
        conversationId: "conv_demo_invoice",
        messageId: "<invoice@canvasly.example>",
        from: { address: "billing@canvasly.example", name: "Canvasly" },
        to: [sam],
        subject: "Your July invoice",
        preview: "Your invoice is ready. No action is required.",
        body: "Your July invoice is ready. No action is required. You can find billing details in your workspace settings.",
        ageMs: 432_000_000,
        html: canvaslyInvoiceHtml,
      },
      {
        id: "msg_demo_13",
        conversationId: "conv_demo_hiring",
        messageId: "<position-closed@hireline.example>",
        from: { address: "notifications@hireline.example", name: "Hireline" },
        to: [sam],
        subject: "This position is closed",
        preview:
          "You applied for Senior Frontend Engineer at Northwind Labs. The employer has closed this position.",
        body: "This position is closed\n\nYou applied for Senior Frontend Engineer at Northwind Labs. The employer has closed this position.\n\nWe picked a few similar roles that match your profile. Good luck with your search!",
        ageMs: 302_400_000,
        html: hirelineHtml,
        checks: {
          mailer: "Hireline Notifier",
          intel: {
            ptr: "out-12.sendhub-mail.example",
            asn: 64_501,
            asName: "SendHub Inc.",
            prefix: "203.0.113.64/26",
            country: "US",
          },
          list: { id: "alerts.hireline.example" },
          // Sent through an ESP on its own domain, with no DMARC record for
          // hireline.example: nothing ties the message to the From domain.
          authentication: {
            ip: "203.0.113.87",
            helo: "out-12.sendhub-mail.example",
            mailFrom: "bounces+7731@sendhub-mail.example",
            spf: "pass",
            spfHelo: "pass",
            dkim: [
              {
                domain: "sendhub-mail.example",
                selector: "s1",
                result: "pass",
                signs: ["from", "to", "subject", "date", "list-unsubscribe"],
              },
            ],
            dmarc: "none",
            policy: null,
            spamScore: 1,
          },
          ai: {
            spam: false,
            spamConfidence: 0.18,
            folderId: null,
            folderConfidence: 0.31,
            reason:
              "Automated job-board notification about an application you submitted.",
          },
        },
      },
      {
        id: "msg_demo_14",
        conversationId: "conv_demo_offsite",
        messageId: "<offsite-venues@northwind.example>",
        from: { address: "priya@northwind.example", name: "Priya Nair" },
        to: [sam],
        subject: "Venue shortlist for the offsite",
        preview:
          "I narrowed the offsite venues down to three. All of them can host 40 people and have a quiet room for workshops.",
        body: "Hi Sam,\n\nI narrowed the offsite venues down to three. All of them can host 40 people and have a quiet room for workshops.\n\nCould you pick your favourite by Thursday? I will book it the same day.\n\nPriya",
        ageMs: 12_600_000,
        checks: {
          mailer: "Mozilla Thunderbird 140.2",
          intel: {
            ptr: "mail-sor-f69.google.com",
            asn: 15_169,
            asName: "Google LLC",
            prefix: "198.51.100.0/24",
            country: "US",
          },
          // Sent to Sam's old address and forwarded by Gmail: SPF now checks
          // Gmail's forwarding envelope, while the original DKIM signature and
          // Gmail's ARC seal survive.
          authentication: {
            ip: "198.51.100.113",
            helo: "mail-sor-f69.google.com",
            mailFrom: "sam.old+caf_=sam=demo.example@gmail.com",
            spf: "pass",
            spfHelo: "pass",
            dkim: [
              {
                domain: "northwind.example",
                selector: "nw2026",
                result: "pass",
                signs: ["from", "to", "subject", "date", "message-id"],
              },
            ],
            dmarc: "pass",
            policy: "quarantine",
            spamScore: 0,
            forwardedVia: {
              sealer: "google.com",
              authservId: "mx.google.com",
              helo: "mail.northwind.example",
              ip: "203.0.113.150",
            },
          },
          ai: {
            spam: false,
            spamConfidence: 0.03,
            folderId: null,
            folderConfidence: 0.1,
            reason:
              "A colleague asking for a decision on offsite venues, forwarded from another inbox.",
          },
        },
      },
      {
        id: "msg_demo_15",
        conversationId: "conv_demo_favour",
        messageId: "<favour-4471@freemail.example>",
        // An outsider borrowing a colleague's name from a freemail account.
        from: { address: "maya.chen.desk@freemail.example", name: "Maya Chen" },
        to: [sam],
        subject: "Quick favour before my next meeting",
        preview:
          "Are you at your desk? I need you to handle a small purchase for a client today and I can't take calls.",
        body: "Hi Sam,\n\nAre you at your desk? I need you to handle a small purchase for a client today and I can't take calls — I'm in back-to-back meetings.\n\nReply here as soon as you see this and I'll send the details.\n\nMaya",
        ageMs: 1_500_000,
        checks: {
          direct: true,
          mailer: "Freemail Webmail 9.4",
          intel: {
            ptr: "smtp-out-3.freemail.example",
            asn: 64_502,
            asName: "Freemail Networks B.V.",
            prefix: "198.51.100.128/25",
            country: "NL",
            registry: "ripencc",
          },
          authentication: {
            ip: "198.51.100.177",
            helo: "smtp-out-3.freemail.example",
            mailFrom: "maya.chen.desk@freemail.example",
            spf: "pass",
            spfHelo: "pass",
            dkim: [
              {
                domain: "freemail.example",
                selector: "fm1",
                result: "pass",
                signs: ["from", "to", "subject", "date", "message-id"],
              },
            ],
            dmarc: "pass",
            policy: "reject",
            spamScore: 1,
          },
          ai: {
            spam: false,
            spamConfidence: 0.62,
            folderId: null,
            folderConfidence: 0,
            reason:
              "Urgent favour request from a free webmail account that uses a colleague's name; possible impersonation.",
          },
        },
      },
      {
        id: "msg_demo_16",
        conversationId: "conv_demo_password",
        messageId: "<expiry-20931@demo-examp1e.com>",
        from: {
          address: "it-support@demo-examp1e.com",
          name: "IT Service Desk",
        },
        to: [sam],
        subject: "Action required: your mailbox password expires today",
        preview:
          "Your password for sam@demo.example expires in 4 hours. Keep your current password to avoid losing access.",
        body: "Your password for sam@demo.example expires in 4 hours.\n\nKeep your current password to avoid losing access to mail and files:\nhttps://demo-examp1e.com/account/keep-password?u=sam\n\nIT Service Desk",
        ageMs: 3_000_000,
        checks: {
          direct: true,
          mailer: "PHPMailer 6.9",
          intel: {
            ptr: "vps-2207.cheap-cloud.example",
            asn: 64_503,
            asName: "Cheap Cloud VPS",
            prefix: "203.0.113.192/26",
            country: "RU",
            registry: "ripencc",
            spamhaus: {
              dbl: [
                {
                  domain: "demo-examp1e.com",
                  code: "127.0.1.4",
                  list: "DBL phishing domain",
                },
              ],
              domains: ["demo-examp1e.com"],
            },
          },
          authentication: {
            ip: "203.0.113.207",
            helo: "vps-2207.cheap-cloud.example",
            mailFrom: "it-support@demo-examp1e.com",
            spf: "pass",
            spfHelo: "none",
            dkim: [],
            dmarc: "none",
            policy: null,
            spamScore: 3,
          },
          ai: {
            spam: false,
            spamConfidence: 0.71,
            folderId: null,
            folderConfidence: 0,
            reason:
              "Password-expiry notice from demo-examp1e.com, a lookalike of the workspace domain, with a credential link.",
          },
        },
      },
      {
        id: "msg_demo_17",
        conversationId: "conv_demo_meetup",
        messageId: "<meetup-intro@harborlight.example>",
        from: { address: "elena@harborlight.example", name: "Elena Petrova" },
        to: [sam],
        subject: "Intro: design systems meetup in November",
        preview:
          "Priya mentioned you have been rebuilding your mail client. Would you give a 15-minute talk at our meetup?",
        body: "Hi Sam,\n\nPriya mentioned you have been rebuilding your mail client from scratch. We run a small design systems meetup and would love a 15-minute talk in November.\n\nNo slides needed — a live demo is perfect.\n\nElena",
        ageMs: 6_000_000,
        checks: {
          mailer: "Mozilla Thunderbird 140.2",
          intel: {
            ptr: "mx-out.harborlight.example",
            asn: 64_504,
            asName: "Harborlight Studio",
            prefix: "198.51.100.0/27",
            country: "PT",
            registry: "ripencc",
          },
          authentication: {
            ip: "198.51.100.12",
            helo: "mx-out.harborlight.example",
            mailFrom: "elena@harborlight.example",
            spf: "pass",
            spfHelo: "pass",
            dkim: [
              {
                domain: "harborlight.example",
                selector: "hl",
                result: "pass",
                signs: ["from", "to", "subject", "date", "message-id"],
              },
            ],
            dmarc: "pass",
            policy: "quarantine",
            spamScore: 0,
          },
          ai: {
            spam: false,
            spamConfidence: 0.04,
            folderId: null,
            folderConfidence: 0.08,
            reason:
              "A personal speaking invitation that references a mutual colleague.",
          },
        },
      },
      {
        id: "msg_demo_18",
        conversationId: "conv_demo_receipt",
        messageId: "<receipt-1031@orbitalcloud.example>",
        from: {
          address: "billing@orbitalcloud.example",
          name: "Orbital Cloud",
        },
        to: [sam],
        subject: "Your October receipt",
        preview:
          "Thanks for your payment of $48.00 for the Team plan. Your next invoice is due on November 30.",
        body: "Thanks for your payment of $48.00 for the Team plan.\n\nReceipt OC-1031 · Paid with card ending 4242\nYour next invoice is due on November 30.\n\nOrbital Cloud Billing",
        ageMs: 20_000_000,
        checks: {
          direct: true,
          mailer: "Orbital Billing",
          intel: {
            ptr: "o12.mail.orbitalcloud.example",
            asn: 64_505,
            asName: "Orbital Cloud Inc.",
            prefix: "203.0.113.0/26",
            country: "US",
            bimi: true,
          },
          authentication: {
            ip: "203.0.113.12",
            helo: "o12.mail.orbitalcloud.example",
            mailFrom: "bounces@mail.orbitalcloud.example",
            spf: "pass",
            spfHelo: "pass",
            dkim: [
              {
                domain: "orbitalcloud.example",
                selector: "oc2026",
                result: "pass",
                signs: ["from", "to", "subject", "date", "message-id"],
              },
            ],
            dmarc: "pass",
            policy: "reject",
            spamScore: 0,
          },
          ai: {
            spam: false,
            spamConfidence: 0.02,
            folderId: null,
            folderConfidence: 0.15,
            reason:
              "Payment receipt from a service the mailbox already pays for, fully authenticated.",
          },
        },
      },
      {
        id: "msg_demo_19",
        conversationId: "conv_demo_bank_details",
        messageId: "<inv-2207-update@paydesk-mailer.example>",
        from: {
          address: "accounts@northwind-supplies.example",
          name: "Northwind Supplies Accounts",
        },
        replyTo: {
          address: "northwind.accounts@quickmail.example",
          name: "Northwind Supplies Accounts",
        },
        to: [sam],
        subject: "Updated bank details for invoice INV-2207",
        preview:
          "Our bank has changed. Please send the payment for INV-2207 to the new account below by end of day.",
        body: "Hello,\n\nOur bank has changed after an internal audit. Please send the payment for invoice INV-2207 (€18,400.00) to the new account below by end of day, and reply to confirm once it is done.\n\nIBAN: XX00 0000 0000 0000 0000 00\nReference: INV-2207\n\nKind regards,\nAccounts team",
        ageMs: 1_800_000,
        checks: {
          mailer: "PayDesk Mailer 3.1",
          intel: {
            ptr: "smtp-4.paydesk-mailer.example",
            asn: 64_506,
            asName: "PayDesk Mailer Ltd",
            prefix: "198.51.100.128/26",
            country: "NL",
            registry: "ripencc",
          },
          authentication: {
            ip: "198.51.100.140",
            helo: "smtp-4.paydesk-mailer.example",
            mailFrom: "bounce-2207@paydesk-mailer.example",
            spf: "pass",
            spfHelo: "pass",
            dkim: [
              {
                domain: "paydesk-mailer.example",
                selector: "pd1",
                result: "pass",
                signs: ["from", "to", "subject", "date", "reply-to"],
              },
            ],
            dmarc: "none",
            policy: null,
            spamScore: 2,
          },
          ai: {
            spam: false,
            spamConfidence: 0.58,
            folderId: null,
            folderConfidence: 0,
            reason:
              "Payment redirection request whose replies go to a free-mail address; possible invoice fraud.",
          },
        },
      },
    ];
  }

  if (mailboxId === "mbx_demo_support") {
    return [
      {
        id: "msg_demo_08",
        conversationId: "conv_demo_customer1",
        messageId: "<help1@customer.demo>",
        from: { address: "noah@northstar.example", name: "Noah Williams" },
        to: [support],
        subject: "Can we use our own sending domain?",
        preview:
          "We are evaluating the product for our studio and need mail to come from our existing domain.",
        body: "Hi team,\n\nWe are evaluating the product for our studio and need mail to come from our existing domain. Is that supported, and which DNS records do we need to add?\n\nThanks,\nNoah",
        ageMs: 900_000,
      },
      {
        id: "msg_demo_09",
        conversationId: "conv_demo_customer2",
        messageId: "<help2@customer.demo>",
        from: { address: "amina@harbor.example", name: "Amina Okafor" },
        to: [support],
        subject: "Importing an existing mailbox",
        preview:
          "Is there a recommended path for importing a few years of historical email?",
        body: "Hello,\n\nIs there a recommended path for importing a few years of historical email? We have roughly 18 GB and would like to preserve threads if possible.\n\nAmina",
        ageMs: 7_200_000,
      },
      {
        id: "msg_demo_10",
        conversationId: "conv_demo_customer3",
        messageId: "<help3@customer.demo>",
        from: { address: "lea@atelier.example", name: "Léa Martin" },
        to: [support],
        subject: "Shared inbox notifications",
        preview:
          "Could each person choose which shared mailboxes should send browser notifications?",
        body: "Bonjour,\n\nCould each person choose which shared mailboxes should send browser notifications? We have support and press addresses, but not everyone needs both.\n\nMerci,\nLéa",
        ageMs: 97_200_000,
      },
      {
        id: "msg_demo_11",
        conversationId: "conv_demo_customer3",
        messageId: "<support-reply@demo>",
        direction: "outgoing",
        from: support,
        to: [{ address: "lea@atelier.example", name: "Léa Martin" }],
        subject: "Re: Shared inbox notifications",
        preview:
          "Yes — notification preferences are per person and per mailbox.",
        body: "Hi Léa,\n\nYes — notification preferences are per person and per mailbox. You can stay in the shared inbox without receiving every browser notification.\n\nBest,\nMaya",
        ageMs: 90_000_000,
        references: ["<help3@customer.demo>"],
      },
      {
        id: "msg_demo_12",
        conversationId: "conv_demo_spam",
        messageId: "<promo@spam.demo>",
        from: { address: "offers@growth-hack.invalid", name: "Growth Network" },
        to: [support],
        subject: "10x your pipeline overnight",
        preview: "One weird trick your competitors do not want you to know.",
        body: "One weird trick your competitors do not want you to know.",
        ageMs: 345_600_000,
        checks: {
          direct: true,
          intel: {
            ptr: "77-2-0-192.dyn.broadband-pool.example",
            fcrdns: false,
            generic: true,
            asn: 64_511,
            asName: "Bulk Hosting Ltd",
            prefix: "192.0.2.0/24",
            country: "SC",
            registry: "afrinic",
            spamhaus: {
              zen: [
                {
                  code: "127.0.0.4",
                  list: "XBL (compromised host)",
                  severity: "abuse",
                },
              ],
              dbl: [
                {
                  domain: "growth-hack.invalid",
                  code: "127.0.1.2",
                  list: "DBL spam domain",
                },
              ],
              domains: ["growth-hack.invalid"],
            },
          },
          authentication: {
            ip: "192.0.2.77",
            helo: "bulk-mailer",
            mailFrom: "offers@growth-hack.invalid",
            spf: "softfail",
            spfHelo: "none",
            dkim: [
              {
                domain: "bulk-sender.example",
                selector: "default",
                result: "pass",
                signs: ["from", "subject", "date"],
              },
            ],
            dmarc: "fail",
            policy: "none",
            spamScore: 5,
          },
          ai: {
            spam: true,
            spamConfidence: 0.97,
            folderId: null,
            folderConfidence: 0,
            reason:
              "Unsolicited bulk promotion with exaggerated claims from a sender that fails SPF and DMARC.",
          },
        },
      },
      {
        id: "msg_demo_20",
        conversationId: "conv_demo_quota",
        messageId: "<quota-77@mail-quota-alerts.example>",
        from: {
          address: "admin@mail-quota-alerts.example",
          name: "Mailbox Administrator",
        },
        to: [support],
        subject: "Your mailbox storage is full",
        preview:
          "Incoming messages are being held. Verify your account within 24 hours to release them.",
        body: "Your mailbox storage is full.\n\n14 incoming messages are being held. Verify your account within 24 hours to release them:\nhttps://mail-quota-alerts.example/verify?box=support\n\nMailbox Administrator",
        ageMs: 5_400_000,
        checks: {
          direct: true,
          mailer: "PHPMailer 6.9",
          intel: {
            ptr: null,
            asn: 64_509,
            asName: "Anon VPS Hosting",
            prefix: "192.0.2.128/25",
            country: "PA",
            registry: "lacnic",
          },
          authentication: {
            ip: "192.0.2.201",
            helo: "localhost",
            mailFrom: "admin@mail-quota-alerts.example",
            spf: "none",
            spfHelo: "none",
            dkim: [],
            dmarc: "none",
            policy: null,
            spamScore: 4,
          },
          ai: {
            spam: true,
            spamConfidence: 0.91,
            folderId: null,
            folderConfidence: 0,
            reason:
              "Credential-harvesting storage warning from an unauthenticated sender with a verification link.",
          },
        },
      },
    ];
  }

  return [];
}

/** A tiny self-made logo for the fictional orbitalcloud.example (SVG Tiny PS). */
const orbitalCloudLogo =
  '<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 64 64"><title>Orbital Cloud</title><rect width="64" height="64" fill="#1e3a8a"/><circle cx="32" cy="32" r="11" fill="#f8fafc"/><ellipse cx="32" cy="32" rx="23" ry="8" fill="none" stroke="#7dd3fc" stroke-width="3" transform="rotate(-24 32 32)"/><circle cx="51" cy="24" r="3.5" fill="#fbbf24"/></svg>';

/**
 * Earlier correspondence the demo implies but does not seed as messages, so
 * known contacts do not all read as first-time senders.
 */
export function demoMailboxSenders(mailboxId: string, now = Date.now()) {
  const known = (
    address: string,
    messageCount: number,
    outboundCount: number,
    firstSeenDaysAgo: number
  ) => ({
    address,
    domain: demoDomain(address),
    firstSeenAt: new Date(now - firstSeenDaysAgo * 86_400_000),
    lastSeenAt: new Date(now - 7 * 86_400_000),
    messageCount,
    outboundCount,
    lastOutboundAt: outboundCount ? new Date(now - 10 * 86_400_000) : null,
  });

  if (mailboxId === "mbx_demo_personal") {
    return [
      known("jessica@edgeworks.example", 6, 4, 210),
      known("rafael@vertex.example", 9, 7, 400),
      known("digest@margin-notes.example", 40, 0, 300),
      known("billing@canvasly.example", 12, 0, 365),
      known("notifications@hireline.example", 5, 0, 60),
      known("priya@northwind.example", 14, 11, 500),
      known("billing@orbitalcloud.example", 9, 0, 280),
      known("accounts@northwind-supplies.example", 4, 2, 150),
      // Blocked before the demo starts: future mail from the domain goes to Spam.
      {
        address: "@prize-center.example",
        domain: "prize-center.example",
        blockedAt: new Date(now - 20 * 86_400_000),
      },
    ];
  }

  if (mailboxId === "mbx_demo_support") {
    return [known("amina@harbor.example", 2, 1, 30)];
  }

  return [];
}

export function demoMailboxEmails(
  mailboxId: string,
  now = Date.now()
): NewEmail[] {
  return demoInputs(mailboxId).map((input) => email(input, now));
}

/** HTML bodies and originals to store in R2 before seeding, keyed as the rows reference them. */
export function demoMailboxObjects(mailboxId: string, now = Date.now()) {
  return demoInputs(mailboxId).flatMap((input) => [
    ...(input.html
      ? [
          {
            key: demoHtmlKey(input.id),
            body: input.html,
            contentType: "text/html; charset=utf-8",
          },
        ]
      : []),
    ...(input.checks
      ? [
          {
            key: demoRawKey(input.id),
            body: demoRawMime(input, now),
            contentType: "message/rfc822",
          },
        ]
      : []),
    ...(input.checks?.intel?.bimi
      ? [
          {
            key: bimiObjectKey(demoDomain(input.from.address)),
            body: orbitalCloudLogo,
            contentType: "image/svg+xml",
            customMetadata: {
              status: "ok",
              checkedAt: String(now),
              reason: "",
            },
          },
        ]
      : []),
  ]);
}

export function demoMailboxFolders(mailboxId: string): NewFolder[] {
  if (mailboxId !== "mbx_demo_personal") return [];

  return [
    {
      id: "Product",
      name: "Product",
      sortOrder: 100,
    },
    {
      id: "Pitch Decks",
      name: "Pitch Decks",
      sortOrder: 110,
    },
  ];
}

export function demoMailboxConversationState(mailboxId: string) {
  // Conversations the security actions move are reset on every demo login.
  const inbox = { mailboxState: "active" as const, folderId: null };

  if (mailboxId === "mbx_demo_personal") {
    return [
      { id: "conv_demo_weekly", ...inbox },
      { id: "conv_demo_password", ...inbox },
      { id: "conv_demo_bank_details", ...inbox },
      { id: "conv_demo_hiring", ...inbox },
      { id: "conv_demo_receipt", ...inbox },
      { id: "conv_demo_maya", folderId: "Product" },
      { id: "conv_demo_vertex", folderId: "Pitch Decks" },
      { id: "conv_demo_invoice", mailboxState: "archive" as const },
    ];
  }

  if (mailboxId === "mbx_demo_support") {
    return [
      { id: "conv_demo_spam", mailboxState: "spam" as const },
      { id: "conv_demo_quota", mailboxState: "spam" as const },
    ];
  }

  return [];
}

/** Message ids whose report labels a demo login clears. */
export function demoMailboxEmailIds(mailboxId: string) {
  return demoInputs(mailboxId).map((input) => input.id);
}
