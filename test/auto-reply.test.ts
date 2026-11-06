import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  autoReplyStatus,
  buildAutoReply,
  messageSkipReason,
  parseHeaderBlock,
} from "../worker/mail/auto-reply";
import { inboundMessageId } from "../worker/mail/inbound";
import { mailboxStub, type AutoReplyInput } from "../worker/mailbox";

const own = "me@example.test";
const encoder = new TextEncoder();

function headersOf(lines: string[]) {
  return parseHeaderBlock(encoder.encode([...lines, "", "body"].join("\r\n")).buffer);
}

function skipReason(lines: string[], envelopeFrom = "alice@example.net", to = own) {
  return messageSkipReason({
    headers: headersOf(lines),
    envelopeFrom,
    mailboxAddress: own,
    email: {
      fromJson: [{ address: envelopeFrom, name: null }],
      toJson: [{ address: to, name: null }],
      ccJson: [],
    },
  });
}

describe("auto-reply rules", () => {
  it("parses folded and repeated headers without reading the body", () => {
    const headers = headersOf([
      "Subject: Hello",
      "List-Id: Team",
      "\t<team.example.net>",
      "Received: one",
      "Received: two",
    ]);
    expect(headers.get("list-id")).toBe("Team <team.example.net>");
    expect(headers.get("received")).toBe("one, two");
  });

  it.each([
    [["Auto-Submitted: auto-replied"], "auto-submitted"],
    [["Auto-Submitted: auto-generated; owner-email=x@y"], "auto-submitted"],
    [["Precedence: bulk"], "precedence"],
    [["Precedence: list"], "precedence"],
    [["List-Id: <team.example.net>"], "mailing list"],
    [["List-Unsubscribe: <mailto:u@example.net>"], "mailing list"],
    [["X-Auto-Response-Suppress: OOF, AutoReply"], "x-auto-response-suppress"],
    [["X-Auto-Response-Suppress: All"], "x-auto-response-suppress"],
    [["Content-Type: multipart/report; report-type=delivery-status"], "delivery report"],
    [['Content-Type: text/calendar; method="REPLY"'], "calendar response"],
  ])("skips %j", (lines, reason) => {
    expect(skipReason(lines)).toBe(reason);
  });

  it("answers Auto-Submitted: no and ordinary mail", () => {
    expect(skipReason(["Auto-Submitted: no", "Precedence: first-class"])).toBeNull();
    expect(skipReason(["Subject: Lunch?"])).toBeNull();
  });

  it.each([
    ["", "empty envelope sender"],
    ["<>", "empty envelope sender"],
    ["MAILER-DAEMON@example.net", "system sender"],
    ["postmaster@example.net", "system sender"],
    ["no-reply@example.net", "system sender"],
    ["noreply@example.net", "system sender"],
    ["do-not-reply@example.net", "system sender"],
    ["bounces+abc@example.net", "system sender"],
    ["Me@Example.test", "own address"],
  ])("skips envelope sender %j", (envelopeFrom, reason) => {
    expect(skipReason([], envelopeFrom)).toBe(reason);
  });

  it("skips mail that does not address the mailbox directly", () => {
    expect(skipReason([], "alice@example.net", "someone-else@example.test"))
      .toBe("not addressed directly");
  });

  it("follows the schedule window", () => {
    const now = new Date("2026-07-10T12:00:00Z");
    const window = (startsAt: string | null, endsAt: string | null) => ({
      enabled: true,
      startsAt: startsAt ? new Date(startsAt) : null,
      endsAt: endsAt ? new Date(endsAt) : null,
    });
    expect(autoReplyStatus(null, now)).toBe("off");
    expect(autoReplyStatus({ ...window(null, null), enabled: false }, now)).toBe("off");
    expect(autoReplyStatus(window(null, null), now)).toBe("active");
    expect(autoReplyStatus(window("2026-07-11T00:00:00Z", null), now)).toBe("scheduled");
    expect(autoReplyStatus(window("2026-07-01T00:00:00Z", "2026-07-20T00:00:00Z"), now)).toBe("active");
    expect(autoReplyStatus(window(null, "2026-07-10T12:00:00Z"), now)).toBe("ended");
  });

  it("marks the reply as automatic and threads it to the original", () => {
    expect(buildAutoReply({
      mailboxAddress: own,
      mailboxName: "Me",
      recipient: "alice@example.net",
      original: {
        subject: "Contract",
        messageIdHeader: "<m2@example.net>",
        inReplyToJson: ["<m1@example.net>"],
        referencesJson: ["<m1@example.net>"],
      },
      subject: null,
      bodyText: "Away until Monday.",
    })).toEqual({
      from: { name: "Me", email: own },
      to: "alice@example.net",
      subject: "Auto: Contract",
      text: "Away until Monday.",
      headers: {
        "Auto-Submitted": "auto-replied",
        "X-Auto-Response-Suppress": "All",
        "In-Reply-To": "<m2@example.net>",
        References: "<m1@example.net> <m2@example.net>",
      },
    });
  });
});

describe("auto-reply delivery", () => {
  it("answers each sender once per interval and never lists, bounces, or Bcc copies", async () => {
    const mailboxId = `mbx_auto_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(env, mailboxId);
    const settings: AutoReplyInput = {
      enabled: true,
      startsAt: null,
      endsAt: null,
      timeZone: "UTC",
      subject: null,
      bodyText: "I am away until Monday.",
      audience: "everyone",
      skipInternal: true,
      replyIntervalDays: 4,
    };
    await mailbox.setAutoReply(settings, "usr_test");

    const deliveryIds: Record<string, string> = {};
    const deliver = async (label: string, envelopeFrom: string, headers: string[]) => {
      const id = `delivery_${label}_${crypto.randomUUID()}`;
      deliveryIds[label] = id;
      const rawObjectKey = `test/${id}.eml`;
      await env.MAIL_STORAGE.put(rawObjectKey, [
        `From: ${envelopeFrom || "daemon@example.net"}`,
        `Subject: ${label}`,
        `Message-ID: <${id}@example.net>`,
        ...headers,
        "Content-Type: text/plain",
        "",
        `Body of ${label}`,
      ].join("\r\n"));
      await mailbox.enqueueInbound({
        id,
        mailboxId,
        rawObjectKey,
        envelopeFrom,
        envelopeTo: own,
        receivedAt: Date.now(),
      });
      await runInDurableObject(mailbox, async (instance, state) => {
        await state.storage.deleteAlarm();
        await instance.alarm();
      });
    };
    const answered = async () => (await mailbox.recentAutoReplies())
      .map((entry) => entry.senderAddress)
      .sort();

    await deliver("first", "alice@example.net", [`To: ${own}`]);
    await expect.poll(answered).toEqual(["alice@example.net"]);
    await deliver("second", "alice@example.net", [`To: ${own}`]);
    await deliver("list", "bob@example.net", [`To: ${own}`, "List-Id: <team.example.net>"]);
    await deliver("bounce", "", [`To: ${own}`]);
    await deliver("bcc", "carol@example.net", ["To: team@example.net"]);
    await deliver("loop", "robot@example.net", [`To: ${own}`, "Auto-Submitted: auto-replied"]);
    // Delivered last: once it is answered, the messages above were evaluated.
    await deliver("marker", "dave@example.net", [`Cc: ${own}`, "To: x@example.net"]);
    await expect.poll(answered).toEqual(["alice@example.net", "dave@example.net"]);

    const alice = (await mailbox.recentAutoReplies())
      .find((entry) => entry.senderAddress === "alice@example.net");
    expect(alice?.lastOriginalEmailId).toBe(inboundMessageId(deliveryIds.first!));
    await expect.poll(async () => (await mailbox.recentAutoReplies())
      .every((entry) => entry.lastOutboundMessageId)).toBe(true);

    // Switching off and on starts a new absence with a clean log.
    await mailbox.setAutoReply({ ...settings, enabled: false }, "usr_test");
    await mailbox.setAutoReply(settings, "usr_test");
    expect(await mailbox.recentAutoReplies()).toEqual([]);
    expect(await mailbox.autoReplyState()).toBe("active");
  });
});

describe("auto-reply API", () => {
  it("validates settings and reports status and recent replies", async () => {
    const { exports } = await import("cloudflare:workers");
    const bootstrap = await exports.default.fetch(new Request("http://example.test/api/auth/mock/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    }));
    expect(bootstrap.status).toBe(200);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    await bootstrap.json();
    const call = async (path: string, init: RequestInit = {}) => {
      const response = await exports.default.fetch(new Request(`http://example.test${path}`, {
        ...init,
        headers: { cookie, "content-type": "application/json" },
      }));
      return { status: response.status, body: await response.json<Record<string, any>>() };
    };
    const { body: { mailboxes: [mailbox] } } = await call("/api/mail/mailboxes");
    expect(mailbox.autoReply).toBe("off");
    const path = `/api/mail/mailboxes/${mailbox.id}/auto-reply`;
    expect(await call(path)).toMatchObject({
      status: 200,
      body: { status: "off", settings: null, recent: [] },
    });

    const put = (body: unknown) => call(path, { method: "PUT", body: JSON.stringify(body) });
    expect((await put({ enabled: true })).status).toBe(400);
    expect((await put({
      enabled: true,
      bodyText: "Away",
      startsAt: "2026-07-10T00:00:00Z",
      endsAt: "2026-07-09T00:00:00Z",
    })).status).toBe(400);

    const saved = await put({
      enabled: true,
      bodyText: "  Away until Monday.  ",
      endsAt: "2099-01-01T00:00:00Z",
      audience: "knownSenders",
    });
    expect(saved).toMatchObject({
      status: 200,
      body: {
        status: "active",
        settings: {
          enabled: true,
          bodyText: "Away until Monday.",
          audience: "knownSenders",
          skipInternal: true,
          replyIntervalDays: 4,
          subject: null,
        },
      },
    });
    expect((await call("/api/mail/mailboxes")).body.mailboxes[0].autoReply).toBe("active");
    expect((await call("/api/mail/mailboxes/mbx_missing/auto-reply")).status).toBe(403);
  });
});
