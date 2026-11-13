import { format } from "date-fns";

import type { MessageDetail } from "./types";

function escapeHtml(value: string) {
  return value.replaceAll(
    /[&<>"']/gu,
    (character) => `&#${character.charCodeAt(0)};`
  );
}

/**
 * Prints one message through a throwaway iframe: a plain header block, then the
 * rendered HTML body (copied from the reader's sanitized frame) or the text.
 */
export function printMessage(
  message: MessageDetail,
  renderedHtml: string | null
) {
  const rows = [
    [
      "From",
      message.fromName
        ? `${message.fromName} <${message.fromAddress}>`
        : message.fromAddress,
    ],
    ["To", message.toAddresses.join(", ")],
    ...(message.ccAddresses.length
      ? [["Cc", message.ccAddresses.join(", ")]]
      : []),
    [
      "Date",
      format(new Date(message.timelineAt), "EEEE, MMMM d, yyyy 'at' HH:mm"),
    ],
  ];

  const header = `
    <h1 style="font:600 20px/1.3 system-ui,sans-serif;margin:0 0 12px">${escapeHtml(message.subject || "(no subject)")}</h1>
    <table style="font:13px/1.5 system-ui,sans-serif;color:#444;border-collapse:collapse;margin-bottom:16px">
      ${rows.map(([label, value]) => `<tr><td style="padding-right:12px;color:#888">${label}</td><td>${escapeHtml(value ?? "")}</td></tr>`).join("")}
    </table>
    <hr style="border:0;border-top:1px solid #ddd;margin:0 0 16px">`;

  const body =
    renderedHtml ??
    `<pre style="font:14px/1.6 system-ui,sans-serif;white-space:pre-wrap;margin:0">${escapeHtml(message.bodyText ?? message.preview ?? "")}</pre>`;

  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const document_ = frame.contentDocument;

  if (!document_) {
    frame.remove();

    return;
  }

  document_.open();
  document_.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(message.subject)}</title></head><body style="margin:24px">${header}${body}</body></html>`
  );
  document_.close();
  const cleanup = () => window.setTimeout(() => frame.remove(), 1000);
  frame.contentWindow?.addEventListener("afterprint", cleanup, { once: true });
  // Let images in the copied body settle before the print dialog snapshots it.
  window.setTimeout(() => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
  }, 250);
}

/** The reader's sanitized HTML body for a message, if it rendered as HTML. */
export function renderedMessageHtml(messageId: string) {
  const frame = document.querySelector<HTMLIFrameElement>(
    `[data-message-id="${CSS.escape(messageId)}"] iframe`
  );

  const document_ = frame?.contentDocument;

  if (!document_?.body) return null;

  // Keep the email's own stylesheets; the body's contents leave out its
  // fit-to-pane scaling, which is on the body element itself.
  const styles = [...document_.querySelectorAll("style")]
    .map((style) => style.outerHTML)
    .join("");

  return styles + document_.body.innerHTML;
}
