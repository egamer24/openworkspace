import { parse } from "tldts";

import { normalizeIp } from "../../shared/mail-received";
import { isWorkspaceDomain } from "./message-security";
import { organizationalDomain } from "./org-domain";

export const MAX_LINK_DOMAINS = 10;
const MAX_SCAN_CHARACTERS = 512 * 1024;

function hostDomain(value: string) {
  try {
    const url = new URL(value.replaceAll("&amp;", "&"));

    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.replaceAll(/^\[|\]$/gu, "");

    if (normalizeIp(host)) return null;

    return organizationalDomain(host);
  } catch {
    return null;
  }
}

/**
 * Registrable domains of the links in a message, in order of first
 * appearance, without the workspace's own domains. Used for Spamhaus DBL.
 */
export function linkDomains(input: {
  html?: string | null;
  text?: (string | null | undefined)[];
  workspaceDomains?: readonly string[];
  limit?: number;
}) {
  const candidates: string[] = [];
  const html = input.html?.slice(0, MAX_SCAN_CHARACTERS) ?? "";

  for (const match of html.matchAll(
    /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu
  )) {
    candidates.push((match[1] ?? match[2] ?? match[3] ?? "").trim());
  }

  // Visible text only: image sources and other attributes are not links.
  const visible = html.replaceAll(/<[^>]*>/gu, " ");

  const text = [visible, ...(input.text ?? [])]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_SCAN_CHARACTERS * 2);

  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'()[\]{}]+/giu)) {
    candidates.push(match[0]);
  }

  // Scheme-less links people still click, such as "goo.gl/0667" typed into a
  // field a platform echoes back. A path is required so file names and plain
  // domains in prose are left alone.
  for (const match of text.matchAll(
    /(?<![@\w./-])((?:[a-z0-9-]+\.)+[a-z]{2,24})\/[^\s<>"'()[\]{}]*/giu
  )) {
    if (parse(match[1]).isIcann) candidates.push(`https://${match[0]}`);
  }

  const domains: string[] = [];

  for (const candidate of candidates) {
    const domain = hostDomain(candidate);

    if (!domain || domains.includes(domain)) continue;

    if (isWorkspaceDomain(domain, input.workspaceDomains ?? [])) continue;
    domains.push(domain);

    if (domains.length >= (input.limit ?? MAX_LINK_DOMAINS)) break;
  }

  return domains;
}
