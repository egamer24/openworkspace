import type { InboundAuthentication } from "../../shared/mail-authentication";
import { headerValues, parseMailDate } from "../../shared/mail-headers";
import { receivedHops } from "../../shared/mail-received";
import type { ReceivedHop } from "../../shared/mail-received";

export {
  ipKind,
  receivedHops,
  type IpKind,
  type ReceivedHop,
} from "../../shared/mail-received";

export function originalHeaderValues(raw: string, name: string) {
  return headerValues(raw, name);
}

export function dkimSigningDomains(raw: string) {
  return [
    ...new Set(
      originalHeaderValues(raw, "dkim-signature").flatMap((signature) => {
        const domain = /(?:^|;)\s*d=([^;\s]+)/iu.exec(signature)?.[1];

        return domain ? [domain.toLocaleLowerCase()] : [];
      })
    ),
  ];
}

function headerValue(raw: string, name: string) {
  return originalHeaderValues(raw, name)[0] ?? null;
}

function tagValue(value: string, tag: string) {
  return (
    new RegExp(`(?:^|;)\\s*${tag}=([^;]+)`, "iu").exec(value)?.[1]?.trim() ??
    null
  );
}

type DkimSignature = {
  domain: string;
  selector: string | null;
  algorithm: string | null;
  signedHeaders: string[];
};

export function dkimSignatures(raw: string): DkimSignature[] {
  return originalHeaderValues(raw, "dkim-signature").flatMap((signature) => {
    const domain = tagValue(signature, "d");

    if (!domain) return [];

    return [
      {
        domain: domain.toLocaleLowerCase(),
        selector: tagValue(signature, "s"),
        algorithm: tagValue(signature, "a"),
        signedHeaders: (tagValue(signature, "h") ?? "")
          .split(":")
          .map((header) => header.trim().toLocaleLowerCase())
          .filter(Boolean),
      },
    ];
  });
}

export type MimePart = {
  depth: number;
  contentType: string;
  charset: string | null;
  encoding: string | null;
  filename: string | null;
  bytes: number;
};

const MAX_MIME_PARTS = 64;

function splitEntity(entity: string) {
  const separator = /\r?\n\r?\n/u.exec(entity);

  if (!separator) return { headers: entity, body: "" };

  return {
    headers: entity.slice(0, separator.index),
    body: entity.slice(separator.index + separator[0].length),
  };
}

function walkMime(entity: string, depth: number, parts: MimePart[]) {
  if (parts.length >= MAX_MIME_PARTS) return;
  const { headers, body } = splitEntity(entity);
  const contentType = headerValue(headers, "content-type") ?? "text/plain";
  const [mediaType = ""] = contentType.split(";");
  const type = mediaType.trim().toLocaleLowerCase();
  const disposition = headerValue(headers, "content-disposition") ?? "";

  const quoted = (value: string | null) =>
    value?.replaceAll(/^"|"$/gu, "") ?? null;

  parts.push({
    depth,
    contentType: type,
    charset: quoted(tagValue(contentType, "charset")),
    encoding: headerValue(headers, "content-transfer-encoding"),
    filename: quoted(
      tagValue(disposition, "filename") ?? tagValue(contentType, "name")
    ),
    bytes: new TextEncoder().encode(body).byteLength,
  });

  if (!type.startsWith("multipart/")) return;
  const boundary = quoted(tagValue(contentType, "boundary"));

  if (!boundary) return;
  const delimiter = `--${boundary}`;
  const sections = body.split(delimiter).slice(1);

  for (const section of sections) {
    if (section.startsWith("--")) break;
    walkMime(section.replace(/^\r?\n/u, ""), depth + 1, parts);
  }
}

/** Flattened MIME tree, parents before children, capped for huge messages. */
export function mimeStructure(raw: string): MimePart[] {
  const parts: MimePart[] = [];
  walkMime(raw, 0, parts);

  return parts;
}

type OriginalSenderDetails = {
  /** Return-Path when present; Cloudflare adds none, so the SMTP MAIL FROM otherwise. */
  returnPath: string | null;
  /** Connecting IP as seen by Cloudflare; never taken from sender-reported hops. */
  senderIp: string | null;
  mailer: string | null;
  listId: string | null;
  precedence: string | null;
};

export function originalSenderDetails(
  raw: string,
  authentication: Pick<
    InboundAuthentication,
    "remoteIp" | "envelopeFrom"
  > | null = null,
  hops: ReceivedHop[] = receivedHops(raw)
): OriginalSenderDetails {
  const trustedHop = hops.find((hop) => hop.trusted);

  return {
    returnPath:
      headerValue(raw, "return-path")?.replaceAll(/^<|>$/gu, "") ||
      authentication?.envelopeFrom ||
      null,
    senderIp: authentication?.remoteIp ?? trustedHop?.ip ?? null,
    mailer: headerValue(raw, "x-mailer") ?? headerValue(raw, "user-agent"),
    listId: headerValue(raw, "list-id"),
    precedence: headerValue(raw, "precedence"),
  };
}

/**
 * End-to-end transit: the trusted Cloudflare hop minus the earliest dated
 * hop, or minus the sender's Date header when no other hop carries a date.
 */
export function transitTime(raw: string, hops: ReceivedHop[]) {
  const arrivalHop = hops.find((hop) => hop.trusted) ?? hops.at(-1);
  const arrival = arrivalHop?.at;

  if (!arrival) return null;

  const earliest = hops.find(
    (hop) =>
      hop !== arrivalHop && hop.at && hop.at.getTime() <= arrival.getTime()
  )?.at;

  if (earliest) {
    return {
      ms: arrival.getTime() - earliest.getTime(),
      basis: "hops" as const,
    };
  }

  const date = parseMailDate(headerValue(raw, "date"));

  return date && date.getTime() <= arrival.getTime()
    ? { ms: arrival.getTime() - date.getTime(), basis: "date-header" as const }
    : null;
}
