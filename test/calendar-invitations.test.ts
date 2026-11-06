import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseIcs } from "../worker/calendar/ics";
import { inboundMessageId } from "../worker/mail/inbound";
import { cloudflareDmarcPass } from "../worker/mail/rfc";
import { mailboxStub } from "../worker/mailbox";
import type { StoredAttachment } from "../worker/mailbox/model";
import {
  googleReply,
  googleRequest,
  invitationMime,
  OUTLOOK_UID,
  outlookCancel,
  outlookReply,
  outlookRequest,
} from "./fixtures/itip";

function call(cookie: string | null, path: string, init: { method?: string; json?: unknown } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return exports.default.fetch(new Request(`http://example.test${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  }));
}

let session: Promise<{ cookie: string; mailboxId: string }> | null = null;

/** One admin per file; the first bootstrap also creates admin@example.test. */
function signIn() {
  session ??= (async () => {
    const bootstrap = await call(null, "/api/auth/mock/bootstrap", {
      method: "POST",
      json: { name: "Admin", email: "admin@example.test" },
    });
    expect(bootstrap.status).toBe(200);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
    const { mailboxes } = await (await call(cookie, "/api/mail/mailboxes"))
      .json<{ mailboxes: Array<{ id: string; address: string }> }>();
    const mailboxId = mailboxes.find((item) => item.address === "admin@example.test")!.id;
    return { cookie, mailboxId };
  })();
  return session;
}

async function setModule(cookie: string, enabled: boolean) {
  expect((await call(cookie, "/api/admin/calendar", { method: "PUT", json: { enabled } })).status).toBe(200);
}

/** What Cloudflare Email Routing prepends; `domain` is the DMARC-aligned From domain. */
function cloudflareAuth(domain: string, dmarc = "pass", authservId = "mx.cloudflare.net") {
  return `Authentication-Results: ${authservId};\r\n\tdkim=pass header.d=${domain};\r\n\tspf=pass smtp.mailfrom=${domain};\r\n\tdmarc=${dmarc} header.from=${domain} policy.dmarc=none`;
}

/** Delivers as Cloudflare would, with a passing DMARC check unless `headers` says otherwise. */
async function deliver(mailboxId: string, input: Parameters<typeof invitationMime>[0]) {
  const id = `delivery_${crypto.randomUUID()}`;
  const rawObjectKey = `test/${id}/raw.eml`;
  const domain = input.from.match(/@([^>\s]+)/u)![1]!;
  await env.MAIL_STORAGE.put(rawObjectKey, invitationMime({ headers: [cloudflareAuth(domain)], ...input }));
  const mailbox = mailboxStub(env, mailboxId);
  await mailbox.enqueueInbound({
    id,
    mailboxId,
    rawObjectKey,
    envelopeFrom: input.from,
    envelopeTo: input.to,
    receivedAt: Date.now(),
  });
  await runDurableObjectAlarm(mailbox);
  const email = await mailbox.getEmail(inboundMessageId(id));
  expect(email).not.toBeNull();
  return email!;
}

type SentRow = { id: string; subject: string; to: string[]; attachments: StoredAttachment[] };

async function sentMessages(mailboxId: string): Promise<SentRow[]> {
  return runInDurableObject(mailboxStub(env, mailboxId), (_, state) => state.storage.sql
    .exec<{ id: string; subject: string; to_json: string; attachments_json: string }>(
      "select id, subject, to_json, attachments_json from emails where direction = 'outgoing' order by timeline_at, rowid",
    )
    .toArray()
    .map((row) => ({
      id: row.id,
      subject: row.subject,
      to: (JSON.parse(row.to_json) as Array<{ address: string }>).map((item) => item.address),
      attachments: JSON.parse(row.attachments_json) as StoredAttachment[],
    })));
}

async function sentIcs(row: SentRow) {
  const [attachment] = row.attachments;
  expect(attachment?.filename).toBe("invite.ics");
  const text = await (await env.MAIL_STORAGE.get(attachment!.r2Key))!.text();
  return { contentType: attachment!.contentType, ...parseIcs(text) };
}

describe("iCalendar fixtures from other clients", () => {
  it("parses a Google Calendar invitation", () => {
    const parsed = parseIcs(googleRequest);
    expect(parsed.method).toBe("REQUEST");
    expect(parsed.skipped).toEqual([]);
    expect(parsed.events[0]).toMatchObject({
      uid: "5k2v8e1qj0m3h7t9c4b6a2d1f0@google.com",
      title: "Planning sync",
      startsAt: Date.parse("2026-12-10T15:00:00Z"),
      endsAt: Date.parse("2026-12-10T16:00:00Z"),
      timeZone: "America/New_York",
      location: "https://meet.google.com/abc-defg-hij",
      organizer: { address: "grace@gmail.example", name: "Grace Hopper", mailboxId: null },
      attendees: [
        { address: "grace@gmail.example", partstat: "ACCEPTED", rsvp: true },
        { address: "admin@example.test", partstat: "NEEDS-ACTION", rsvp: true },
      ],
    });
  });

  it("parses Outlook invitations and cancellations with Windows time zones", () => {
    const request = parseIcs(outlookRequest);
    expect(request.method).toBe("REQUEST");
    expect(request.skipped).toEqual([]);
    expect(request.events[0]).toMatchObject({
      uid: OUTLOOK_UID,
      title: "Design review",
      timeZone: "America/Los_Angeles",
      startsAt: Date.parse("2026-12-08T22:00:00Z"),
      rrule: "FREQ=WEEKLY;BYDAY=TU;UNTIL=20270126T220000Z",
      location: "Microsoft Teams Meeting",
      organizer: { address: "alan@contoso.example", name: "Alan Turing" },
      attendees: [
        { address: "admin@example.test", role: "REQ-PARTICIPANT" },
        { address: "ada@contoso.example", role: "OPT-PARTICIPANT" },
      ],
    });
    const cancel = parseIcs(outlookCancel);
    expect(cancel.method).toBe("CANCEL");
    expect(cancel.events[0]).toMatchObject({ uid: OUTLOOK_UID, status: "cancelled", sequence: 1 });
    const reply = parseIcs(outlookReply("uid-1", "ada@contoso.example", "TENTATIVE"));
    expect(reply.method).toBe("REPLY");
    expect(reply.events[0]).toMatchObject({
      organizer: null,
      attendees: [{ address: "ada@contoso.example", partstat: "TENTATIVE" }],
    });
  });
});

describe("cloudflareDmarcPass", () => {
  const mime = (...headers: string[]) => [...headers, "From: alan@contoso.example", "", "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=contoso.example"].join("\r\n");

  it("trusts only a passing, aligned first header from mx.cloudflare.net", () => {
    expect(cloudflareDmarcPass(mime(cloudflareAuth("contoso.example")), "alan@contoso.example")).toBe(true);
    expect(cloudflareDmarcPass(mime("authentication-results: MX.Cloudflare.NET (comment); DMARC=Pass header.from=Contoso.Example"), "Alan@CONTOSO.example")).toBe(true);
    expect(cloudflareDmarcPass(new TextEncoder().encode(mime(cloudflareAuth("contoso.example"))).buffer, "alan@contoso.example")).toBe(true);
  });

  it("rejects missing, failing, misaligned, foreign or later headers", () => {
    const from = "alan@contoso.example";
    expect(cloudflareDmarcPass(mime(), from)).toBe(false);
    expect(cloudflareDmarcPass(mime(cloudflareAuth("contoso.example", "fail")), from)).toBe(false);
    expect(cloudflareDmarcPass(mime(cloudflareAuth("contoso.example", "none")), from)).toBe(false);
    expect(cloudflareDmarcPass(mime(cloudflareAuth("evil.example")), from)).toBe(false);
    expect(cloudflareDmarcPass(mime(cloudflareAuth("mail.contoso.example")), from)).toBe(false);
    expect(cloudflareDmarcPass(mime(cloudflareAuth("contoso.example", "pass", "mx.cloudflare.net.evil.example")), from)).toBe(false);
    expect(cloudflareDmarcPass(mime(cloudflareAuth("contoso.example", "fail"), cloudflareAuth("contoso.example")), from)).toBe(false);
    expect(cloudflareDmarcPass(mime("Authentication-Results: mx.cloudflare.net; spf=pass reason=\"dmarc=pass header.from=contoso.example\""), from)).toBe(false);
  });
});

describe("calendar invitations", () => {
  it("ignores calendar parts while the module is off", async () => {
    const { cookie, mailboxId } = await signIn();
    await setModule(cookie, false);
    const email = await deliver(mailboxId, {
      from: "Grace Hopper <grace@gmail.example>",
      to: "admin@example.test",
      subject: "Invitation: Planning sync",
      method: "REQUEST",
      ics: googleRequest,
      style: "google",
    });
    expect(email.invitationJson).toBeNull();
  });

  it("sends REQUEST, update and CANCEL messages and applies replies from attendees only", async () => {
    const { cookie, mailboxId } = await signIn();
    await setModule(cookie, true);
    const before = (await sentMessages(mailboxId)).length;

    const created = await call(cookie, "/api/calendar/events", {
      method: "POST",
      json: {
        title: "Launch review",
        startsAt: "2026-12-15T17:00:00Z",
        endsAt: "2026-12-15T18:00:00Z",
        timeZone: "Europe/London",
        attendees: [
          { address: "grace@gmail.example", name: "Grace Hopper" },
          { address: "ada@contoso.example" },
        ],
        mailboxId,
        sendInvitations: true,
      },
    });
    expect(created.status).toBe(200);
    const { event, invitationsSent } = await created.json<{
      event: { id: string; uid: string }; invitationsSent: number;
    }>();
    expect(invitationsSent).toBe(1);
    let sent = (await sentMessages(mailboxId)).slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      subject: "Invitation: Launch review",
      to: ["grace@gmail.example", "ada@contoso.example"],
    });
    const request = await sentIcs(sent[0]!);
    expect(request.contentType).toBe("text/calendar; method=REQUEST; charset=UTF-8");
    expect(request.method).toBe("REQUEST");
    expect(request.events).toHaveLength(1);
    expect(request.events[0]).toMatchObject({
      uid: event.uid,
      sequence: 0,
      title: "Launch review",
      startsAt: Date.parse("2026-12-15T17:00:00Z"),
      organizer: { address: "admin@example.test", name: "Admin" },
      attendees: [
        { address: "grace@gmail.example", name: "Grace Hopper", partstat: "NEEDS-ACTION", rsvp: true },
        { address: "ada@contoso.example", partstat: "NEEDS-ACTION", rsvp: true },
      ],
    });

    // Replies: Google from an attendee applies; a forged sender and a reply
    // naming someone else do not.
    await deliver(mailboxId, {
      from: "Grace Hopper <grace@gmail.example>",
      to: "admin@example.test",
      subject: "Accepted: Launch review",
      method: "REPLY",
      ics: googleReply(event.uid, "grace@gmail.example", "ACCEPTED"),
      style: "google",
    });
    await deliver(mailboxId, {
      from: "Mallory <mallory@evil.example>",
      to: "admin@example.test",
      subject: "Declined: Launch review",
      method: "REPLY",
      ics: googleReply(event.uid, "grace@gmail.example", "DECLINED"),
      style: "google",
    });
    await deliver(mailboxId, {
      from: "Ada Lovelace <ada@contoso.example>",
      to: "admin@example.test",
      subject: "Tentative: Launch review",
      method: "REPLY",
      ics: outlookReply(event.uid, "ada@contoso.example", "TENTATIVE"),
      style: "outlook",
    });
    const stored = await (await call(cookie, `/api/calendar/events/${event.id}`))
      .json<{ event: { attendees: Array<{ address: string; partstat: string }> } }>();
    expect(stored.event.attendees.map((item) => [item.address, item.partstat])).toEqual([
      ["grace@gmail.example", "ACCEPTED"],
      ["ada@contoso.example", "TENTATIVE"],
    ]);

    // Update: SEQUENCE increments; the removed attendee gets a CANCEL.
    const updated = await call(cookie, `/api/calendar/events/${event.id}`, {
      method: "PATCH",
      json: {
        title: "Launch review (moved)",
        startsAt: "2026-12-15T18:00:00Z",
        endsAt: "2026-12-15T19:00:00Z",
        attendees: [{ address: "grace@gmail.example" }],
        sendInvitations: true,
      },
    });
    expect(updated.status).toBe(200);
    expect((await updated.json<{ invitationsSent: number }>()).invitationsSent).toBe(2);
    sent = (await sentMessages(mailboxId)).slice(before);
    expect(sent.map((row) => [row.subject, row.to])).toEqual([
      ["Invitation: Launch review", ["grace@gmail.example", "ada@contoso.example"]],
      ["Cancelled: Launch review (moved)", ["ada@contoso.example"]],
      ["Updated invitation: Launch review (moved)", ["grace@gmail.example"]],
    ]);
    const removed = await sentIcs(sent[1]!);
    expect(removed.method).toBe("CANCEL");
    expect(removed.events[0]).toMatchObject({ status: "cancelled", attendees: [{ address: "ada@contoso.example" }] });
    const update = await sentIcs(sent[2]!);
    expect(update.method).toBe("REQUEST");
    expect(update.events[0]).toMatchObject({
      sequence: 1,
      startsAt: Date.parse("2026-12-15T18:00:00Z"),
      attendees: [{ address: "grace@gmail.example", partstat: "ACCEPTED" }],
    });

    // Delete: everyone still invited gets a CANCEL with a higher SEQUENCE.
    const deleted = await call(cookie, `/api/calendar/events/${event.id}?sendInvitations=true`, { method: "DELETE" });
    expect((await deleted.json<{ invitationsSent: number }>()).invitationsSent).toBe(1);
    sent = (await sentMessages(mailboxId)).slice(before);
    expect(sent.at(-1)).toMatchObject({ subject: "Cancelled: Launch review (moved)", to: ["grace@gmail.example"] });
    const cancel = await sentIcs(sent.at(-1)!);
    expect(cancel.method).toBe("CANCEL");
    expect(cancel.events[0]).toMatchObject({ uid: event.uid, sequence: 2, status: "cancelled" });

    // MCP-style creation records attendees without emailing them.
    const quiet = await call(cookie, "/api/calendar/events", {
      method: "POST",
      json: {
        title: "Quiet",
        startsAt: "2026-12-16T17:00:00Z",
        endsAt: "2026-12-16T18:00:00Z",
        timeZone: "UTC",
        attendees: [{ address: "grace@gmail.example" }],
        mailboxId,
      },
    });
    expect(await quiet.json()).toMatchObject({
      invitationsSent: 0,
      event: { attendees: [{ address: "grace@gmail.example", partstat: "NEEDS-ACTION" }] },
    });
    expect(await sentMessages(mailboxId)).toHaveLength(before + 4);
  });

  it("shows incoming invitations, answers them and follows the organizer's cancellation", async () => {
    const { cookie, mailboxId } = await signIn();
    await setModule(cookie, true);
    // A busy event overlapping the Google invitation.
    expect((await call(cookie, "/api/calendar/events", {
      method: "POST",
      json: {
        title: "Dentist",
        startsAt: "2026-12-10T15:30:00Z",
        endsAt: "2026-12-10T16:30:00Z",
        timeZone: "UTC",
      },
    })).status).toBe(200);

    const google = await deliver(mailboxId, {
      from: "Grace Hopper <grace@gmail.example>",
      to: "admin@example.test",
      subject: "Invitation: Planning sync @ Thu Dec 10, 2026 10am - 11am (EST)",
      method: "REQUEST",
      ics: googleRequest,
      style: "google",
    });
    expect(google.invitationJson).toMatchObject({
      method: "REQUEST",
      title: "Planning sync",
      organizer: { address: "grace@gmail.example" },
    });
    const cardPath = `/api/mail/mailboxes/${mailboxId}/messages/${google.id}/invitation`;
    expect(await (await call(cookie, cardPath)).json()).toMatchObject({
      invitation: { uid: "5k2v8e1qj0m3h7t9c4b6a2d1f0@google.com", startsAt: Date.parse("2026-12-10T15:00:00Z") },
      conflicts: [{ startsAt: Date.parse("2026-12-10T15:30:00Z"), endsAt: Date.parse("2026-12-10T16:00:00Z") }],
      response: null,
      canRespond: true,
    });

    const before = (await sentMessages(mailboxId)).length;
    const accepted = await call(cookie, `${cardPath}/respond`, { method: "POST", json: { response: "ACCEPTED" } });
    expect(accepted.status).toBe(200);
    const { eventId } = await accepted.json<{ eventId: string }>();
    const sent = (await sentMessages(mailboxId)).slice(before);
    expect(sent).toMatchObject([{ subject: "Accepted: Planning sync", to: ["grace@gmail.example"] }]);
    const reply = await sentIcs(sent[0]!);
    expect(reply.method).toBe("REPLY");
    expect(reply.events[0]).toMatchObject({
      uid: "5k2v8e1qj0m3h7t9c4b6a2d1f0@google.com",
      organizer: { address: "grace@gmail.example" },
      attendees: [{ address: "admin@example.test", partstat: "ACCEPTED" }],
    });
    const replyEmail = await mailboxStub(env, mailboxId).getEmail(sent[0]!.id);
    expect(replyEmail).toMatchObject({ conversationId: google.conversationId });
    expect(replyEmail?.inReplyToJson).toEqual([google.messageIdHeader]);
    const added = await (await call(cookie, `/api/calendar/events/${eventId}`)).json<{
      event: { title: string; organizer: { address: string; mailboxId: string | null } };
    }>();
    expect(added.event).toMatchObject({
      title: "Planning sync",
      organizer: { address: "grace@gmail.example", mailboxId: null },
    });
    expect(await (await call(cookie, cardPath)).json()).toMatchObject({ response: "ACCEPTED" });

    // Outlook: tentative, then a forged and a real cancellation.
    const outlook = await deliver(mailboxId, {
      from: "Alan Turing <alan@contoso.example>",
      to: "admin@example.test",
      subject: "Design review",
      method: "REQUEST",
      ics: outlookRequest,
      style: "outlook",
    });
    const tentative = await call(cookie, `/api/mail/mailboxes/${mailboxId}/messages/${outlook.id}/invitation/respond`, {
      method: "POST",
      json: { response: "TENTATIVE" },
    });
    const outlookEventId = (await tentative.json<{ eventId: string }>()).eventId;
    const eventStatus = async () => (await (await call(cookie, `/api/calendar/events/${outlookEventId}`))
      .json<{ event: { status: string; timeZone: string } }>()).event;
    expect(await eventStatus()).toMatchObject({ status: "tentative", timeZone: "America/Los_Angeles" });
    const forged = await deliver(mailboxId, {
      from: "Mallory <mallory@evil.example>",
      to: "admin@example.test",
      subject: "Canceled: Design review",
      method: "CANCEL",
      ics: outlookCancel,
      style: "outlook",
    });
    expect(forged.invitationJson).toMatchObject({ method: "CANCEL" });
    expect((await eventStatus()).status).toBe("tentative");
    await deliver(mailboxId, {
      from: "Alan Turing <alan@contoso.example>",
      to: "admin@example.test",
      subject: "Canceled: Design review",
      method: "CANCEL",
      ics: outlookCancel,
      style: "outlook",
    });
    expect((await eventStatus()).status).toBe("cancelled");

    // Declining removes the event again.
    const declined = await call(cookie, `${cardPath}/respond`, { method: "POST", json: { response: "DECLINED" } });
    expect(await declined.json()).toMatchObject({ response: "DECLINED", eventId: null });
    expect((await call(cookie, `/api/calendar/events/${eventId}`)).status).toBe(404);
  });

  it("applies a CANCEL or REPLY only when Cloudflare's DMARC check passes for the From domain", async () => {
    const { cookie, mailboxId } = await signIn();
    await setModule(cookie, true);
    const uid = `spoof-${crypto.randomUUID()}`;
    const invite = await deliver(mailboxId, {
      from: "Alan Turing <alan@contoso.example>",
      to: "admin@example.test",
      subject: "Design review",
      method: "REQUEST",
      ics: outlookRequest.replaceAll(OUTLOOK_UID, uid),
      style: "outlook",
    });
    const accepted = await call(cookie, `/api/mail/mailboxes/${mailboxId}/messages/${invite.id}/invitation/respond`, {
      method: "POST",
      json: { response: "ACCEPTED" },
    });
    const { eventId } = await accepted.json<{ eventId: string }>();
    const status = async () => (await (await call(cookie, `/api/calendar/events/${eventId}`))
      .json<{ event: { status: string } }>()).event.status;
    const cancel = (headers: string[]) => deliver(mailboxId, {
      from: "Alan Turing <alan@contoso.example>",
      to: "admin@example.test",
      subject: "Canceled: Design review",
      method: "CANCEL",
      ics: outlookCancel.replaceAll(OUTLOOK_UID, uid),
      style: "outlook",
      headers,
    });
    const forgeries = [
      [],
      [cloudflareAuth("contoso.example", "fail")],
      [cloudflareAuth("evil.example")],
      [cloudflareAuth("contoso.example", "pass", "mx.evil.example")],
      [cloudflareAuth("contoso.example", "fail"), cloudflareAuth("contoso.example")],
    ];
    for (const headers of forgeries) {
      expect((await cancel(headers)).invitationJson).toMatchObject({ method: "CANCEL" });
      expect(await status()).toBe("confirmed");
    }
    await cancel([cloudflareAuth("CONTOSO.example")]);
    expect(await status()).toBe("cancelled");

    const created = await call(cookie, "/api/calendar/events", {
      method: "POST",
      json: {
        title: "Budget",
        startsAt: "2026-12-17T17:00:00Z",
        endsAt: "2026-12-17T18:00:00Z",
        timeZone: "UTC",
        attendees: [{ address: "bob@external.example" }],
        mailboxId,
      },
    });
    const { event } = await created.json<{ event: { id: string; uid: string } }>();
    const partstat = async () => (await (await call(cookie, `/api/calendar/events/${event.id}`))
      .json<{ event: { attendees: Array<{ partstat: string }> } }>()).event.attendees[0]!.partstat;
    const reply = (headers: string[]) => deliver(mailboxId, {
      from: "Bob <bob@external.example>",
      to: "admin@example.test",
      subject: "Declined: Budget",
      method: "REPLY",
      ics: googleReply(event.uid, "bob@external.example", "DECLINED"),
      style: "google",
      headers,
    });
    await reply([cloudflareAuth("external.example", "fail")]);
    await reply([]);
    expect(await partstat()).toBe("NEEDS-ACTION");
    await reply([cloudflareAuth("external.example")]);
    expect(await partstat()).toBe("DECLINED");
  });

  it("keeps an accepted event when a REQUEST with its UID names another organizer", async () => {
    const { cookie, mailboxId } = await signIn();
    await setModule(cookie, true);
    const uid = `hijack-${crypto.randomUUID()}`;
    const respond = async (from: string, ics: string) => {
      const invite = await deliver(mailboxId, {
        from, to: "admin@example.test", subject: "Design review", method: "REQUEST", ics, style: "outlook",
      });
      return call(cookie, `/api/mail/mailboxes/${mailboxId}/messages/${invite.id}/invitation/respond`, {
        method: "POST",
        json: { response: "ACCEPTED" },
      });
    };
    const request = outlookRequest.replaceAll(OUTLOOK_UID, uid);
    const { eventId } = await (await respond("Alan Turing <alan@contoso.example>", request)).json<{ eventId: string }>();
    const hijack = await respond(
      "Mallory <mallory@evil.example>",
      request.replace("mailto:alan@contoso.example", "mailto:mallory@evil.example").replace("SUMMARY;LANGUAGE=en-US:Design review", "SUMMARY:Moved"),
    );
    expect(hijack.status).toBe(400);
    expect(await (await call(cookie, `/api/calendar/events/${eventId}`)).json()).toMatchObject({
      event: { title: "Design review", organizer: { address: "alan@contoso.example" } },
    });
  });
});
