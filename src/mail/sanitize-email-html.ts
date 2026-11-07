import {
  isComposerInlineImageContentType,
} from "../../shared/mail";
import {
  isRemoteHttpUrl,
  mailRemoteProxyPath,
} from "../../shared/mail-remote";
import type { MessageAttachment } from "./types";

const FORBIDDEN_TAGS = [
  "script",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "meta",
  "link",
  "base",
  "object",
  "embed",
  "iframe",
  "audio",
  "video",
  "source",
  "svg",
  "math",
];

const FORBIDDEN_ATTRIBUTES = [
  "poster",
  "action",
  "formaction",
];

const COMPOSER_TAGS = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "div",
  "em",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "section",
  "span",
  "strong",
  "u",
  "ul",
];

const COMPOSER_ATTRIBUTES = [
  "alt",
  "data-forwarded-message",
  "data-linked-attachment-card",
  "href",
  "loading",
  "referrerpolicy",
  "rel",
  "src",
  "srcset",
  "target",
  "title",
];

const DANGEROUS_CSS =
  /expression\s*\(|-moz-binding|behavior\s*:|@import|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html/giu;

/**
 * Keep email layout CSS while blocking scriptable CSS.
 * Remote `url(...)` values are rewritten through the Worker proxy when provided.
 */
export function sanitizeEmailCss(
  css: string,
  rewriteRemoteUrl?: (url: string) => string | null,
) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const withoutDanger = withoutComments.replace(DANGEROUS_CSS, "/* blocked */");
  return withoutDanger.replace(
    /url\s*\(\s*(['"]?)([^)'"]*?)\1\s*\)/giu,
    (match, _quote: string, rawUrl: string) => {
      const url = rawUrl.trim();
      if (/^data:image\/(?:gif|jpeg|jpg|png|webp)/iu.test(url)) return match;
      if (/^cid:/iu.test(url)) return match;
      if (isRemoteHttpUrl(url) && rewriteRemoteUrl) {
        const proxied = rewriteRemoteUrl(url);
        if (proxied) return `url("${proxied}")`;
      }
      return "/* remote url blocked */";
    },
  );
}

function normalizedContentId(value: string) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed percent escapes are treated as an opaque content ID.
  }
  return decoded
    .replace(/^cid:/iu, "")
    .replace(/^<|>$/gu, "")
    .trim()
    .toLocaleLowerCase();
}

function safeLink(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function inlineAttachmentUrls(
  mailboxId: string,
  messageId: string,
  attachments: MessageAttachment[],
) {
  const values = new Map<string, string>();
  for (const attachment of attachments) {
    if (
      !attachment.contentId
      || !isComposerInlineImageContentType(attachment.contentType)
    ) {
      continue;
    }
    values.set(
      normalizedContentId(attachment.contentId),
      `/api/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}/inline?mailboxId=${encodeURIComponent(mailboxId)}`,
    );
  }
  return values;
}

export function rewriteSrcset(
  value: string,
  rewriteRemoteUrl: (url: string) => string | null,
) {
  return value
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return "";
      const match = /^(\S+)(\s+.+)?$/u.exec(trimmed);
      if (!match) return "";
      const [, source = "", descriptor = ""] = match;
      // Like src: anything not proxied (e.g. protocol-relative //host) is dropped.
      if (!isRemoteHttpUrl(source)) return "";
      const proxied = rewriteRemoteUrl(source);
      return proxied ? `${proxied}${descriptor}` : "";
    })
    .filter(Boolean)
    .join(", ");
}

function scrubStyles(
  root: ParentNode,
  rewriteRemoteUrl: (url: string) => string | null,
) {
  for (const element of root.querySelectorAll("[style]")) {
    const style = element.getAttribute("style");
    if (!style) continue;
    const next = sanitizeEmailCss(style, rewriteRemoteUrl);
    if (next.trim()) element.setAttribute("style", next);
    else element.removeAttribute("style");
  }
  for (const styleTag of root.querySelectorAll("style")) {
    styleTag.textContent = sanitizeEmailCss(
      styleTag.textContent ?? "",
      rewriteRemoteUrl,
    );
  }
}

function isRichEmailDocument(document: Document) {
  const richElement = document.querySelector([
    "a[href]",
    "img",
    "table",
    "ul",
    "ol",
    "blockquote",
    "pre",
    "code",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "mark",
    "sub",
    "sup",
    "hr",
    "[style]",
    "[class]",
    "[bgcolor]",
    "[background]",
    "[color]",
    "[width]",
    "[height]",
    "[align]",
  ].join(","));
  if (richElement) return true;
  return [...document.querySelectorAll("style")]
    .some((style) => Boolean(style.textContent?.trim()));
}

export type SafeEmailDocument = {
  composerHtml: string;
  srcDoc: string;
  proxiedRemoteImages: number;
  renderAsHtml: boolean;
};

export async function sanitizeEmailHtml(input: {
  html: string;
  mailboxId: string;
  messageId: string;
  attachments: MessageAttachment[];
}): Promise<SafeEmailDocument> {
  const rewriteRemoteUrl = (url: string) =>
    mailRemoteProxyPath(input.mailboxId, url);

  const { default: DOMPurify } = await import("dompurify");
  const sanitized = DOMPurify.sanitize(input.html, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ["style"],
    ADD_ATTR: [
      "style",
      "bgcolor",
      "color",
      "width",
      "height",
      "align",
      "valign",
      "background",
      "srcset",
    ],
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
  });
  const document = new DOMParser().parseFromString(sanitized, "text/html");
  scrubStyles(document, rewriteRemoteUrl);
  const renderAsHtml = isRichEmailDocument(document);
  const inlineUrls = inlineAttachmentUrls(
    input.mailboxId,
    input.messageId,
    input.attachments,
  );
  let proxiedRemoteImages = 0;

  for (const image of document.querySelectorAll("img")) {
    const source = image.getAttribute("src")?.trim() ?? "";
    const inlineUrl = source.toLocaleLowerCase().startsWith("cid:")
      ? inlineUrls.get(normalizedContentId(source))
      : undefined;
    const safeDataImage =
      /^data:image\/(?:gif|jpeg|png|webp);base64,[a-z0-9+/=\s]+$/iu.test(source);
    if (inlineUrl) {
      image.setAttribute("src", inlineUrl);
      image.setAttribute("loading", "lazy");
    } else if (safeDataImage) {
      // keep as-is
    } else if (isRemoteHttpUrl(source)) {
      image.setAttribute("src", rewriteRemoteUrl(source));
      image.setAttribute("loading", "lazy");
      image.setAttribute("referrerpolicy", "no-referrer");
      proxiedRemoteImages += 1;
    } else if (source) {
      image.removeAttribute("src");
    }

    const srcset = image.getAttribute("srcset")?.trim() ?? "";
    if (srcset) {
      const rewritten = rewriteSrcset(srcset, rewriteRemoteUrl);
      if (rewritten) image.setAttribute("srcset", rewritten);
      else image.removeAttribute("srcset");
    }
  }

  for (const element of document.querySelectorAll("[background]")) {
    const background = element.getAttribute("background")?.trim() ?? "";
    if (isRemoteHttpUrl(background)) {
      element.setAttribute("background", rewriteRemoteUrl(background));
      proxiedRemoteImages += 1;
    } else {
      element.removeAttribute("background");
    }
  }

  for (const link of document.querySelectorAll("a")) {
    const href = link.getAttribute("href")?.trim() ?? "";
    if (!safeLink(href)) {
      link.removeAttribute("href");
      continue;
    }
    if (!href.toLocaleLowerCase().startsWith("mailto:")) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
  }

  const headStyles = [...document.querySelectorAll("head style")]
    .map((node) => node.outerHTML)
    .join("\n");
  const body = document.body.innerHTML;
  // Composer HTML is rendered in the app document, so sender-controlled CSS,
  // classes, and layout attributes must not cross that boundary. The iframe
  // path below remains intentionally more permissive for external email.
  const composerHtml = DOMPurify.sanitize(body, {
    ALLOWED_TAGS: COMPOSER_TAGS,
    ALLOWED_ATTR: COMPOSER_ATTRIBUTES,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
  });
  // Keep the layout guard after sender styles: email templates commonly use
  // fixed 600px tables that otherwise overflow a narrow message iframe.
  const srcDoc = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: light only; }
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      color: #111111;
    }
    body {
      overflow-wrap: anywhere;
      font: 400 15px/1.55 system-ui, -apple-system, sans-serif;
    }
    img { max-width: 100%; height: auto; }
    pre { overflow: auto; white-space: pre-wrap; }
  </style>
  ${headStyles}
  <style>
    html, body {
      width: 100% !important;
      max-width: 100% !important;
      overflow-x: hidden !important;
    }
    *, *::before, *::after { box-sizing: border-box; }
    table { max-width: 100% !important; }
    img { max-width: 100% !important; height: auto !important; }
  </style>
</head>
<body>${body}</body>
</html>`;
  return { composerHtml, srcDoc, proxiedRemoteImages, renderAsHtml };
}
