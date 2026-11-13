import { expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import { inboundHeaderMetadata } from "@open-workspace/email/worker/mail/auth-headers.ts";
import {
  inboundMessageId,
  rawHeaderText,
} from "@open-workspace/email/worker/mail/inbound.ts";
import type { Email } from "@open-workspace/email/worker/mailbox/schema.ts";
import { z } from "zod";

import genotek from "../fixtures/headers/genotek.txt" with { type: "text" };
import { readJson } from "./json.ts";
import { bootstrapAdmin, firstMailboxId } from "./mail-flow-helpers.ts";
import { runAlarmUntil } from "./mailbox-helpers.ts";
import {
  env,
  hooks,
  mailbox as mailboxStub,
  useFreshWorkspace,
  worker,
} from "./workspace.ts";

useFreshWorkspace();

const rawMessage = `${genotek.trimEnd()}\r\n\r\n<p>Newsletter body</p>\r\n`;

it("stores header-derived authentication, unsubscribe data and the envelope at ingestion", async () => {
  const mailboxId = `mbx_auth_${crypto.randomUUID()}`;
  const mailbox = mailboxStub(mailboxId);
  const id = `delivery_${crypto.randomUUID()}`;
  const rawObjectKey = `test/${id}/raw.eml`;
  await env.MAIL_STORAGE.put(rawObjectKey, rawMessage);
  await mailbox.enqueueInbound({
    id,
    mailboxId,
    rawObjectKey,
    envelopeFrom: "bounce.f90e01000000787801005893@cdp.genotek.ru",
    envelopeTo: "user@example.com",
    receivedAt: Date.now(),
  });

  const email = await runAlarmUntil(mailboxId, () =>
    mailbox.getEmail(inboundMessageId(id))
  );

  expect(email).toMatchObject({
    envelopeFrom: "bounce.f90e01000000787801005893@cdp.genotek.ru",
    envelopeTo: "user@example.com",
    authenticationResultsJson: {
      source: "headers",
      verdict: "verified",
      remoteIp: "46.243.2.181",
      spamScore: 1,
    },
    listUnsubscribeJson: { oneClick: true, reason: null },
    // Answered by the offline DoH responder in test/stack/fake-doh.ts.
    senderIntelJson: {
      version: 1,
      source: "live",
      ip: "46.243.2.181",
      ptr: {
        status: "ok",
        names: ["mx3.mail-relay.test"],
        confirmed: "mx3.mail-relay.test",
        fcrdns: true,
        generic: false,
      },
      network: {
        status: "ok",
        asn: 64_496,
        asName: "Example Relay Network GmbH",
        prefix: "46.243.0.0/16",
        country: "DE",
        registry: "ripencc",
      },
      spamhaus: null,
      bimi: null,
    },
  });
  expect(await mailbox.getSenderHistory(["News@Genotek.ru"])).toEqual({
    "news@genotek.ru": { inboundCount: 1, outboundCount: 0 },
  });
});

it("retries sender intelligence on view when ingestion stored none", async () => {
  const mailboxId = `mbx_intel_backfill_${crypto.randomUUID()}`;
  const mailbox = mailboxStub(mailboxId);
  const rawMimeR2Key = `test/${mailboxId}/older.eml`;
  await env.MAIL_STORAGE.put(rawMimeR2Key, rawMessage);
  await mailbox.insertEmail({
    id: "msg_intel_backfill",
    conversationId: "conv_intel_backfill",
    direction: "incoming",
    fromJson: [{ address: "news@genotek.ru", name: "Genotek" }],
    subject: "Lookups failed",
    timelineAt: new Date(),
    transportState: "received",
    rawMimeR2Key,
    ...inboundHeaderMetadata({
      rawHeaders: rawHeaderText(new TextEncoder().encode(rawMessage).buffer),
      fromAddress: "news@genotek.ru",
      envelopeFrom: null,
    }),
  });

  const stored = required(
    await mailbox.getEmail("msg_intel_backfill"),
    "the email was inserted"
  );

  expect(stored.senderIntelJson).toBeNull();

  const filled = await hooks.call<Email>(
    "mailbox.withSenderIntel",
    mailboxId,
    stored.id,
    {
      bodyHtml: null,
      workspaceDomains: ["example.com"],
      dqsKey: null,
    }
  );

  expect(filled.senderIntelJson).toMatchObject({
    ip: "46.243.2.181",
    ptr: { fcrdns: true },
  });
  expect(
    (await mailbox.getEmail("msg_intel_backfill"))?.senderIntelJson
  ).toMatchObject({
    network: { asn: 64_496 },
  });
});

it("opens a conversation without waiting for sender intelligence and fills it in afterwards", async () => {
  const cookie = await bootstrapAdmin();

  const get = (path: string) =>
    worker.fetch(
      new Request(`http://example.test${path}`, { headers: { cookie } })
    );

  const mailboxId = await firstMailboxId(cookie);
  const rawMimeR2Key = `test/${mailboxId}/pending.eml`;
  await env.MAIL_STORAGE.put(rawMimeR2Key, rawMessage);
  await mailboxStub(mailboxId).insertEmail({
    id: "msg_intel_pending",
    conversationId: "conv_intel_pending",
    direction: "incoming",
    fromJson: [{ address: "news@genotek.ru", name: "Genotek" }],
    subject: "Lookups pending",
    timelineAt: new Date(),
    transportState: "received",
    rawMimeR2Key,
    ...inboundHeaderMetadata({
      rawHeaders: rawHeaderText(new TextEncoder().encode(rawMessage).buffer),
      fromAddress: "news@genotek.ru",
      envelopeFrom: null,
    }),
  });

  const conversation = z.object({
    messages: z.array(
      z.looseObject({
        senderIntelPending: z.boolean(),
        senderIntel: z.looseObject({ ip: z.string() }).nullable(),
      })
    ),
  });

  const open = async () => {
    const response = await get(
      `/api/mail/conversations/conv_intel_pending?mailboxId=${mailboxId}`
    );

    expect(response.status).toBe(200);

    const [message] = (await readJson(response, conversation)).messages;

    return required(message, "the conversation has its message");
  };

  // The browser's conversation response does not wait on DNS.
  const first = await open();
  expect(first).toMatchObject({ senderIntelPending: true, senderIntel: null });

  // The follow-up joins (or redoes) the lookup and answers with its result.
  const followUp = await get(
    `/api/mail/messages/msg_intel_pending/sender-intel?mailboxId=${mailboxId}`
  );

  expect(followUp.status).toBe(200);
  expect(await followUp.json()).toMatchObject({
    senderIntelPending: false,
    senderIntel: { ip: "46.243.2.181", ptr: { fcrdns: true } },
    security: { warnings: expect.any(Array) },
  });

  // Stored: the next open has it at once.
  expect(await open()).toMatchObject({
    senderIntelPending: false,
    senderIntel: { ip: "46.243.2.181" },
  });
  expect(
    (
      await get(
        `/api/mail/messages/msg_intel_pending/sender-intel?mailboxId=${mailboxId}`
      )
    ).status
  ).toBe(200);
  expect(
    (
      await get(
        `/api/mail/messages/msg_missing/sender-intel?mailboxId=${mailboxId}`
      )
    ).status
  ).toBe(404);
  expect(
    (
      await get(
        "/api/mail/messages/msg_intel_pending/sender-intel?mailboxId=mbx_not_mine"
      )
    ).status
  ).toBe(403);
});

it("counts correspondents in both directions for the first-time-sender hint", async () => {
  const mailbox = mailboxStub(`mbx_senders_${crypto.randomUUID()}`);

  const base = {
    subject: "Hello",
    timelineAt: new Date(1_700_000_000_000),
  };

  await mailbox.seedMailbox(
    [],
    [
      {
        ...base,
        id: "msg_in_1",
        conversationId: "conv_a",
        direction: "incoming",
        fromJson: [{ address: "Alex@Partner.example", name: null }],
        transportState: "received",
      },
      {
        ...base,
        id: "msg_in_2",
        conversationId: "conv_b",
        direction: "incoming",
        fromJson: [{ address: "alex@partner.example", name: null }],
        transportState: "received",
      },
      {
        ...base,
        id: "msg_out_1",
        conversationId: "conv_c",
        direction: "outgoing",
        fromJson: [{ address: "me@example.com", name: null }],
        toJson: [{ address: "sam@client.example", name: null }],
        ccJson: [{ address: "SAM@client.example", name: null }],
        transportState: "submitted",
      },
    ],
    [],
    [
      {
        address: "old@contact.example",
        domain: "contact.example",
        messageCount: 3,
        outboundCount: 2,
      },
    ]
  );
  // Re-seeding is idempotent: rows already present are not counted twice.
  await mailbox.seedMailbox(
    [],
    [
      {
        ...base,
        id: "msg_in_1",
        conversationId: "conv_a",
        direction: "incoming",
        fromJson: [{ address: "alex@partner.example", name: null }],
        transportState: "received",
      },
    ]
  );
  expect(
    await mailbox.getSenderHistory([
      "alex@partner.example",
      "sam@client.example",
      "old@contact.example",
      "nobody@example.net",
    ])
  ).toEqual({
    "alex@partner.example": { inboundCount: 2, outboundCount: 0 },
    "sam@client.example": { inboundCount: 0, outboundCount: 1 },
    "old@contact.example": { inboundCount: 3, outboundCount: 2 },
  });
});
