import { describe, expect, it } from "bun:test";

import {
  autoReplyRecipient,
  autoReplyStatus,
  buildAutoReply,
  messageSkipReason,
  parseHeaderBlock,
} from "../../worker/mail/auto-reply";

const raw = (text: string) => new TextEncoder().encode(text).buffer;

const own = "me@example.test";

function skip(
  headers: string,
  overrides: {
    envelopeFrom?: string;
    listAddress?: string;
    mailboxState?: "active" | "archive" | "spam" | "trash";
    attachments?: { filename: string; contentType: string }[];
  } = {}
) {
  return messageSkipReason({
    headers: parseHeaderBlock(raw(`${headers}\r\n\r\nBody`)),
    envelopeFrom: overrides.envelopeFrom ?? "ana@example.net",
    ownAddresses: [own, "sales@example.test"],
    listAddress: overrides.listAddress ?? null,
    mailboxState: overrides.mailboxState ?? "active",
    email: {
      attachmentsJson: (overrides.attachments ?? []).map((file) => ({
        ...file,
        id: "a",
        r2Key: "k",
        size: 1,
        contentId: null,
        disposition: "attachment" as const,
        delivery: "attached" as const,
        downloadTokenHash: null,
        downloadExpiresAt: null,
      })),
    },
  });
}

describe("autoReplyStatus", () => {
  const now = new Date("2026-06-10T12:00:00Z");
  const day = (iso: string) => new Date(`2026-06-${iso}T12:00:00Z`);

  it("follows the schedule", () => {
    expect(autoReplyStatus(null, now)).toBe("off");
    expect(
      autoReplyStatus({ enabled: false, startsAt: null, endsAt: null }, now)
    ).toBe("off");
    expect(
      autoReplyStatus({ enabled: true, startsAt: null, endsAt: null }, now)
    ).toBe("active");
    expect(
      autoReplyStatus({ enabled: true, startsAt: day("11"), endsAt: null }, now)
    ).toBe("scheduled");
    expect(
      autoReplyStatus(
        { enabled: true, startsAt: day("01"), endsAt: day("10") },
        now
      )
    ).toBe("ended");
  });
});

describe("parseHeaderBlock", () => {
  it("unfolds lines, lowercases names, joins repeats, stops at the body", () => {
    const headers = parseHeaderBlock(
      raw("Subject: one\r\n two\r\nX-A: 1\r\nX-A: 2\r\n\r\nList-Id: <in body>")
    );

    expect(headers.get("subject")).toBe("one two");
    expect(headers.get("x-a")).toBe("1, 2");
    expect(headers.has("list-id")).toBe(false);
  });
});

describe("messageSkipReason", () => {
  it("lets a direct, personal message through", () => {
    expect(skip("From: ana@example.net\r\nSubject: hi")).toBeNull();
    expect(skip("Auto-Submitted: no")).toBeNull();
  });

  it("never answers automatic, bulk or list mail", () => {
    expect(skip("Auto-Submitted: auto-replied")).toBe("auto-submitted");
    expect(skip("Precedence: bulk")).toBe("precedence");
    expect(skip("Precedence: list")).toBe("precedence");
    expect(skip("List-Id: <team.example.net>")).toBe("mailing list");
    expect(skip("List-Unsubscribe: <mailto:x@example.net>")).toBe(
      "mailing list"
    );
    expect(skip("X-Auto-Response-Suppress: OOF, DR")).toBe(
      "x-auto-response-suppress"
    );
    expect(
      skip("Content-Type: multipart/report; report-type=delivery-status")
    ).toBe("delivery report");
  });

  it("never answers calendar traffic", () => {
    expect(skip("Content-Type: text/calendar; method=REPLY")).toBe(
      "calendar message"
    );
    expect(
      skip("Content-Type: multipart/mixed", {
        attachments: [
          { filename: "invite.ics", contentType: "application/octet-stream" },
        ],
      })
    ).toBe("calendar message");
  });

  it("never answers bounces, system senders, or itself", () => {
    expect(skip("", { envelopeFrom: "" })).toBe("empty envelope sender");
    expect(skip("", { envelopeFrom: "<>" })).toBe("empty envelope sender");

    for (const sender of [
      "MAILER-DAEMON@example.net",
      "postmaster@example.net",
      "noreply@example.net",
      "no-reply@example.net",
      "do-not-reply@example.net",
      "bounces+123@example.net",
    ]) {
      expect(skip("", { envelopeFrom: sender })).toBe("system sender");
    }

    expect(skip("", { envelopeFrom: "Me@Example.test" })).toBe("own address");
    expect(skip("", { envelopeFrom: "sales@example.test" })).toBe(
      "own address"
    );
  });

  it("skips Spam and Trash, but not Archive", () => {
    expect(skip("", { mailboxState: "spam" })).toBe("spam");
    expect(skip("", { mailboxState: "trash" })).toBe("trash");
    expect(skip("", { mailboxState: "archive" })).toBeNull();
  });

  it("goes by delivery, not To: only a mailing list's copy is skipped", () => {
    // Delivered through an alias, a plus address or the catch-all, To names
    // another address; the reply still goes out.
    expect(skip("To: sam+shop@example.test")).toBeNull();
    expect(skip("", { listAddress: "all@example.test" })).toBe(
      "mailing list copy"
    );
  });
});

describe("buildAutoReply", () => {
  const original = {
    subject: "Quarterly report",
    messageIdHeader: "<m2@example.net>",
    inReplyToJson: ["<m1@example.net>"],
    referencesJson: ["<m1@example.net>"],
  };

  it("marks the reply as automatic and threads it", () => {
    expect(
      buildAutoReply({
        from: { address: own, name: "Me" },
        recipient: autoReplyRecipient("<Ana@Example.net>"),
        original,
        message: {
          subject: null,
          html: '<p>Away until Monday.</p><img src="cid:logo@x">',
          text: "Away until Monday.",
        },
        images: [
          {
            contentId: "logo@x",
            filename: "logo.png",
            type: "image/png",
            content: new ArrayBuffer(1),
          },
        ],
      })
    ).toEqual({
      from: { name: "Me", email: own },
      // The domain is lowercased; the local part keeps its case (RFC 5321).
      to: "Ana@example.net",
      subject: "Auto: Quarterly report",
      text: "Away until Monday.",
      html: '<p>Away until Monday.</p><img src="cid:logo@x">',
      attachments: [
        {
          disposition: "inline",
          contentId: "logo@x",
          filename: "logo.png",
          type: "image/png",
          content: new ArrayBuffer(1),
        },
      ],
      headers: {
        "Auto-Submitted": "auto-replied",
        "X-Auto-Response-Suppress": "All",
        "In-Reply-To": "<m2@example.net>",
        References: "<m1@example.net> <m2@example.net>",
      },
    });
  });

  it("keeps header values from other people's mail on one line", () => {
    const reply = buildAutoReply({
      from: { address: own, name: "Me\r\nBcc: victim@example.net" },
      recipient: "ana@example.net",
      original: { ...original, subject: "hi\r\nBcc: victim@example.net" },
      message: { subject: null, html: "<p>Away.</p>", text: "Away." },
    });

    expect(reply.subject).toBe("Auto: hi Bcc: victim@example.net");
    expect(reply.from.name).toBe("Me Bcc: victim@example.net");
  });
});
