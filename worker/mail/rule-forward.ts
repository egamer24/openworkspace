import { EMAIL_SERVICE_MAX_BYTES, forwardSubject } from "../../shared/mail";
import type { Email } from "../mailbox/schema";
import { escapeHtml } from "./outbound-content";
import { FORWARD_HOP_HEADER } from "./rules";

// Leaves room for the bodies and MIME encoding overhead (base64 is ~4/3).
const ATTACHMENT_BUDGET_BYTES = Math.floor(EMAIL_SERVICE_MAX_BYTES * 0.7);

function metadata(email: Email) {
  const from = email.fromJson[0];
  return [
    `From: ${from?.name ? `${from.name} <${from.address}>` : from?.address ?? "unknown"}`,
    `Date: ${email.timelineAt.toUTCString()}`,
    `Subject: ${email.subject}`,
    ...(email.toJson.length ? [`To: ${email.toJson.map((item) => item.address).join(", ")}`] : []),
    ...(email.ccJson.length ? [`Cc: ${email.ccJson.map((item) => item.address).join(", ")}`] : []),
  ];
}

/**
 * A rule forward is a new message from the mailbox (never the original
 * sender, which would fail DMARC) with Reply-To set to the original sender.
 */
export async function buildRuleForward(env: Env, input: {
  email: Email;
  mailboxAddress: string;
  mailboxName: string;
  to: string;
  hops: number;
}) {
  const { email } = input;
  const attachments: EmailAttachment[] = [];
  const skipped: string[] = [];
  let budget = ATTACHMENT_BUDGET_BYTES;
  for (const file of email.attachmentsJson) {
    if (file.delivery !== "attached" || file.size > budget) {
      skipped.push(file.filename);
      continue;
    }
    const object = await env.MAIL_STORAGE.get(file.r2Key);
    if (!object) {
      skipped.push(file.filename);
      continue;
    }
    budget -= file.size;
    const content = await object.arrayBuffer();
    attachments.push(file.disposition === "inline"
      ? { disposition: "inline", contentId: file.contentId ?? file.id, filename: file.filename, type: file.contentType, content }
      : { disposition: "attachment", filename: file.filename, type: file.contentType, content });
  }

  const lines = metadata(email);
  const note = skipped.length
    ? [`Not attached (too large to forward): ${skipped.join(", ")}`]
    : [];
  const body = [email.bodyText ?? "", email.quotedText ?? ""].filter(Boolean).join("\n\n");
  const originalHtml = email.bodyHtmlR2Key
    ? await env.MAIL_STORAGE.get(email.bodyHtmlR2Key).then((object) => object?.text())
    : undefined;
  const header = ["---------- Forwarded message ----------", ...lines, ...note];

  return {
    from: { name: input.mailboxName, email: input.mailboxAddress },
    to: input.to,
    replyTo: email.replyToJson[0]?.address ?? email.fromJson[0]?.address,
    subject: forwardSubject(email.subject),
    text: [...header, "", body].join("\n"),
    html: originalHtml
      ? `<div>${header.map((line) => escapeHtml(line)).join("<br>")}</div><br>${originalHtml}`
      : undefined,
    attachments: attachments.length ? attachments : undefined,
    headers: {
      "Auto-Submitted": "auto-forwarded",
      [FORWARD_HOP_HEADER]: String(input.hops + 1),
    },
  };
}
