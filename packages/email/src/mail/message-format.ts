/** How a message's sender, dates and recipients read in the conversation. */
import { format, isThisYear, isToday } from "date-fns";

import type { Mailbox, MessageDetail } from "./types";

export function senderName(message: MessageDetail) {
  return message.fromName || message.fromAddress;
}

/** The time today, the day this year, the full date before. */
export function shortDate(value: string | number | Date) {
  const date = new Date(value);

  if (isToday(date)) return format(date, "HH:mm");

  if (isThisYear(date)) return format(date, "MMM d, HH:mm");

  return format(date, "MMM d, yyyy");
}

/** Like shortDate, but without the time, for collapsed one-line rows. */
export function compactDate(value: string | number | Date) {
  const date = new Date(value);

  if (isToday(date)) return format(date, "HH:mm");

  if (isThisYear(date)) return format(date, "MMM d");

  return format(date, "dd.MM.yy");
}

/** The date in full, for tooltips and the details list. */
export function fullDate(value: string | number | Date) {
  return format(new Date(value), "EEEE, MMMM d, yyyy 'at' HH:mm");
}

export function isOwnAddress(address: string, mailbox?: Mailbox) {
  return (
    mailbox !== undefined &&
    address.toLowerCase() === mailbox.address.toLowerCase()
  );
}

function recipientLabel(address: string, mailbox?: Mailbox) {
  return isOwnAddress(address, mailbox) ? "me" : address;
}

export function recipientSummary(message: MessageDetail, mailbox?: Mailbox) {
  const to = message.toAddresses.map((address) =>
    recipientLabel(address, mailbox)
  );

  const cc = message.ccAddresses.map((address) =>
    recipientLabel(address, mailbox)
  );

  const parts = [`to ${to.length ? to.join(", ") : "undisclosed recipients"}`];

  if (cc.length) parts.push(`cc ${cc.join(", ")}`);

  if (message.bccAddresses.length) {
    parts.push(`bcc ${message.bccAddresses.length}`);
  }

  if (message.viaList) parts.push(`via ${message.viaList}`);

  return parts.join(" · ");
}

export function listFormat(names: string[]) {
  return new Intl.ListFormat("en", {
    style: "long",
    type: "conjunction",
  }).format(names);
}
