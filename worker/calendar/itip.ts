import type { CalendarAttendee, ItipMethod } from "../../shared/calendar";
import { hashToken } from "../lib/crypto";
import { mailboxStub } from "../mailbox";
import type { StoredAttachment } from "../mailbox/model";
import type { Email, NewEmail } from "../mailbox/schema";
import { messageIdForRequest } from "../mail/outbound";
import { escapeHtml } from "../mail/outbound-content";
import { deferEmailSentWebhook } from "../mail/outbound-service";
import { address, replyThreadHeaders } from "../mail/rfc";
import { createId } from "../lib/ids";
import { serializeCalendar, type IcsEvent } from "./ics";

export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * iTIP parts are sent as an `invite.ics` attachment whose Content-Type
 * carries the method. The structured send API has no way to add a
 * `text/calendar` alternative part; Gmail and Outlook both recognize the
 * attachment form. Auto-responders can skip these messages by this
 * Content-Type (`text/calendar; method=REPLY|CANCEL`).
 */
export function itipContentType(method: ItipMethod) {
  return `text/calendar; method=${method}; charset=UTF-8`;
}

function describeWhen(event: Pick<IcsEvent, "startsAt" | "endsAt" | "allDay" | "timeZone">) {
  if (event.allDay) {
    const format = new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: "UTC" });
    const last = event.endsAt - 86_400_000;
    return last > event.startsAt
      ? `${format.format(event.startsAt)} – ${format.format(last)}`
      : format.format(event.startsAt);
  }
  const format = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: event.timeZone,
  });
  return `${format.formatRange(event.startsAt, event.endsAt)} (${event.timeZone})`;
}

/**
 * Sends one iTIP message through the normal outbound path, so it is stored
 * in Sent and retried like any other message.
 */
export async function sendItip(env: Env, input: {
  mailboxId: string;
  from: { address: string; name: string | null };
  to: string[];
  method: ItipMethod;
  events: IcsEvent[];
  subject: string;
  intro: string;
  related?: Email | null;
  defer: (task: Promise<unknown>) => void;
}) {
  const event = input.events[0];
  if (!event || !input.to.length) return null;
  const ics = serializeCalendar({ method: input.method, events: input.events });
  const id = await messageIdForRequest(input.mailboxId, `itip:${crypto.randomUUID()}`);
  const prefix = `mailboxes/${input.mailboxId}/messages/${id}`;
  const details = [
    ["When", describeWhen(event)],
    ...(event.location ? [["Where", event.location]] : []),
    ...(event.organizer ? [["Organizer", event.organizer.name ?? event.organizer.address]] : []),
  ];
  const bodyText = [
    input.intro,
    "",
    event.title,
    ...details.map(([label, value]) => `${label}: ${value}`),
    ...(event.description && input.method === "REQUEST" ? ["", event.description] : []),
  ].join("\n");
  const html = [
    `<p>${escapeHtml(input.intro)}</p>`,
    `<p><strong>${escapeHtml(event.title)}</strong>`,
    ...details.map(([label, value]) => `<br>${escapeHtml(label!)}: ${escapeHtml(value!)}`),
    "</p>",
    ...(event.description && input.method === "REQUEST"
      ? [`<p style="white-space:pre-wrap">${escapeHtml(event.description)}</p>`]
      : []),
  ].join("");
  const bytes = new TextEncoder().encode(ics);
  const attachment: StoredAttachment = {
    id: "att_1",
    r2Key: `${prefix}/attachments/att_1`,
    filename: "invite.ics",
    contentType: itipContentType(input.method),
    size: bytes.byteLength,
    contentId: null,
    disposition: "attachment",
    delivery: "attached",
    downloadTokenHash: null,
    downloadExpiresAt: null,
  };
  const bodyHtmlR2Key = `${prefix}/body.html`;
  await Promise.all([
    env.MAIL_STORAGE.put(attachment.r2Key, bytes, { httpMetadata: { contentType: attachment.contentType } }),
    env.MAIL_STORAGE.put(bodyHtmlR2Key, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } }),
  ]);
  const thread = input.related ? replyThreadHeaders(input.related) : { inReplyTo: [], references: [] };
  const email: NewEmail = {
    id,
    requestFingerprint: await hashToken(`itip-v1\0${ics}`),
    conversationId: input.related?.conversationId ?? createId("conv"),
    direction: "outgoing",
    messageIdHeader: null,
    inReplyToJson: thread.inReplyTo,
    referencesJson: thread.references,
    fromJson: [address(input.from.address, input.from.name)],
    replyToJson: [],
    toJson: input.to.map((value) => address(value)),
    ccJson: [],
    bccJson: [],
    subject: input.subject,
    preview: bodyText.replace(/\s+/gu, " ").trim().slice(0, 220),
    bodyText,
    quotedText: null,
    bodyHtmlR2Key,
    attachmentsJson: [attachment],
    listId: null,
    listPostAddress: null,
    timelineAt: new Date(),
    transportState: "unconfirmed",
    deliveryStatusJson: [],
  };
  const { email: stored } = await mailboxStub(env, input.mailboxId).submitOutgoing(email);
  deferEmailSentWebhook({ env, mailboxId: input.mailboxId, email: stored, defer: input.defer });
  return stored;
}

/**
 * Sends what changed between two states of one organized series: CANCEL to
 * removed attendees (or to everyone when the series is gone) and REQUEST to
 * the current attendees. Rows are the series master first, as returned by
 * `CalendarDO.seriesRows`. Returns the number of messages sent.
 */
export async function sendSeriesInvitations(env: Env, input: {
  from: { address: string; name: string | null };
  mailboxId: string;
  previous: IcsEvent[];
  current: IcsEvent[];
  defer: (task: Promise<unknown>) => void;
}) {
  const master = input.current[0] ?? input.previous[0];
  if (!master?.organizer?.mailboxId) return 0;
  const recipients = (attendees: CalendarAttendee[]) => attendees
    .map((attendee) => attendee.address)
    .filter((value) => !sameAddress(value, master.organizer!.address));
  const previousAttendees = input.previous[0]?.attendees ?? [];
  const currentAttendees = input.current[0]?.attendees ?? [];
  const removed = previousAttendees.filter((attendee) =>
    !currentAttendees.some((current) => sameAddress(current.address, attendee.address)));
  const common = { env, from: input.from, mailboxId: input.mailboxId, defer: input.defer };
  let sent = 0;
  if (removed.length) {
    const gone = input.current[0] ?? { ...input.previous[0]!, sequence: input.previous[0]!.sequence + 1 };
    const cancelled = await sendItip(env, {
      ...common,
      to: recipients(removed),
      method: "CANCEL",
      events: [{ ...gone, status: "cancelled", attendees: removed }],
      subject: `Cancelled: ${master.title}`,
      intro: input.current.length
        ? "You are no longer invited to this event."
        : "This event has been cancelled.",
    });
    if (cancelled) sent++;
  }
  if (input.current.length) {
    const request = await sendItip(env, {
      ...common,
      to: recipients(currentAttendees),
      method: "REQUEST",
      events: input.current,
      subject: `${input.previous.length ? "Updated invitation" : "Invitation"}: ${master.title}`,
      intro: `${input.from.name ?? input.from.address} ${input.previous.length ? "updated" : "invited you to"} this event.`,
    });
    if (request) sent++;
  }
  return sent;
}
