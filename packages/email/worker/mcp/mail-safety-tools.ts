import type {
  ScopedToolRegistrar,
  AccountApiClient,
} from "@open-workspace/core/module";
import { apiPath, runTool } from "@open-workspace/core/module";
import { z } from "zod";

import {
  MAIL_ORGANIZE_SCOPE,
  MAIL_READ_SCOPE,
  MAIL_SEND_SCOPE,
  BLOCK_SENDERS_SCOPE,
} from "../../shared/permissions";
import { workspaceBlockSchema } from "../admin/schemas";
import { entityIdSchema, mailboxIdSchema } from "./schemas";

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const write = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const messageInputSchema = z.object({
  mailboxId: mailboxIdSchema,
  messageId: entityIdSchema,
});

const blockPatternSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .describe(
    "An email address (alex@example.com) or a domain (example.com or @example.com; also matches its subdomains)."
  );

const nullableString = z.string().nullable();

/** The parts of a message's InboundAuthentication (shared/mail-authentication) the summary reads. */
const authenticationSchema = z.object({
  remoteIp: nullableString,
  helo: nullableString,
  envelopeFrom: nullableString,
  spf: z
    .object({
      result: z.string(),
      domain: nullableString,
      aligned: z.boolean(),
    })
    .nullable(),
  dkim: z.array(
    z.object({
      result: z.string(),
      domain: z.string(),
      selector: nullableString,
      aligned: z.boolean(),
    })
  ),
  dmarc: z
    .object({
      result: z.string(),
      headerFrom: nullableString,
      policy: nullableString,
      alignedVia: z.array(z.string()),
    })
    .nullable(),
  arc: z
    .object({
      result: z.string(),
      chainLength: z.number(),
      sealers: z.array(z.object({ domain: nullableString })),
    })
    .nullable(),
  spamScore: z.number().nullable(),
  verdict: z.string(),
  verdictReason: z.string(),
});

const spamhausListingSchema = z.object({
  zone: z.string(),
  target: z.string(),
  list: z.string(),
  severity: z.string(),
});

/** The parts of a message's SenderIntel (shared/mail-sender-intel) the summary reads. */
const senderIntelSchema = z.object({
  checkedAt: z.number(),
  ip: nullableString,
  ptr: z.object({
    names: z.array(z.string()),
    confirmed: nullableString,
    fcrdns: z.boolean().nullable(),
    generic: z.boolean().nullable(),
  }),
  heloMatchesPtr: z.boolean().nullable(),
  network: z.object({
    asn: z.number().nullable(),
    asName: nullableString,
    country: nullableString,
  }),
  spamhaus: z
    .object({
      zen: z.object({ listings: z.array(spamhausListingSchema) }),
      dbl: z.object({ listings: z.array(spamhausListingSchema) }),
    })
    .nullable(),
});

/** The parts of a message's MessageSecurity (shared/mail-authentication) the summary reads. */
const securitySchema = z.object({
  verdict: z.string(),
  verdictReason: z.string(),
  fromDomain: nullableString,
  mailedBy: nullableString,
  signedBy: nullableString,
  via: nullableString,
  external: z.boolean(),
  listUnsubscribe: z
    .object({
      httpsUrl: nullableString,
      mailto: nullableString,
      oneClick: z.boolean(),
    })
    .nullable(),
  warnings: z.array(z.json()),
  firstTimeSender: z.boolean(),
  replyToMismatch: z
    .object({ address: z.string(), domain: z.string() })
    .nullable(),
});

/** GET /mail/messages/:id/authentication, as far as the summary reads it. */
const authenticationResponseSchema = z.object({
  original: z.object({
    subject: z.string(),
    from: z.string(),
    receivedAt: z.string(),
  }),
  authentication: authenticationSchema.nullable(),
  security: securitySchema.nullable(),
  senderIntel: senderIntelSchema.nullable(),
});

type AuthenticationResponse = z.output<typeof authenticationResponseSchema>;

function authLine(
  result: string,
  details: (string | null | false | undefined)[]
) {
  const extra = details.filter(Boolean).join(", ");

  return extra ? `${result} (${extra})` : result;
}

function compactAuthentication(auth: AuthenticationResponse["authentication"]) {
  if (!auth) return null;

  return {
    spf: auth.spf
      ? authLine(auth.spf.result, [
          auth.spf.domain,
          auth.spf.aligned && "aligned",
        ])
      : null,
    dkim: auth.dkim.map((dkim) =>
      authLine(dkim.result, [
        dkim.domain,
        dkim.selector && `s=${dkim.selector}`,
        dkim.aligned && "aligned",
      ])
    ),
    dmarc: auth.dmarc
      ? authLine(auth.dmarc.result, [
          auth.dmarc.headerFrom,
          auth.dmarc.policy && `p=${auth.dmarc.policy}`,
          auth.dmarc.alignedVia.length > 0 &&
            `via ${auth.dmarc.alignedVia.join("+")}`,
        ])
      : null,
    arc: auth.arc
      ? authLine(auth.arc.result, [
          auth.arc.chainLength > 1 &&
            `forwarded through ${auth.arc.sealers
              .map((sealer) => sealer.domain ?? "unknown")
              .join(", ")}`,
        ])
      : null,
    remoteIp: auth.remoteIp,
    helo: auth.helo,
    envelopeFrom: auth.envelopeFrom,
    spamScore: auth.spamScore,
  };
}

function compactSenderIntel(intel: AuthenticationResponse["senderIntel"]) {
  if (!intel) return null;

  const spamhausHits = intel.spamhaus
    ? [...intel.spamhaus.zen.listings, ...intel.spamhaus.dbl.listings].map(
        (listing) => ({
          zone: listing.zone,
          target: listing.target,
          list: listing.list,
          severity: listing.severity,
        })
      )
    : null;

  return {
    checkedAt: new Date(intel.checkedAt).toISOString(),
    ip: intel.ip,
    ptr: intel.ptr.confirmed ?? intel.ptr.names[0] ?? null,
    forwardConfirmedPtr: intel.ptr.fcrdns,
    genericPtr: intel.ptr.generic,
    heloMatchesPtr: intel.heloMatchesPtr,
    asn: intel.network.asn,
    asName: intel.network.asName,
    country: intel.network.country,
    /** null means Spamhaus is not configured for this workspace. */
    spamhausHits,
  };
}

function compactSecurity(messageId: string, response: AuthenticationResponse) {
  const { security } = response;
  const unsubscribe = security?.listUnsubscribe ?? null;

  return {
    ok: true,
    messageId,
    from: response.original.from,
    subject: response.original.subject,
    receivedAt: response.original.receivedAt,
    verdict:
      security?.verdict ?? response.authentication?.verdict ?? "unavailable",
    verdictReason:
      security?.verdictReason ?? response.authentication?.verdictReason ?? null,
    fromDomain: security?.fromDomain ?? null,
    mailedBy: security?.mailedBy ?? null,
    signedBy: security?.signedBy ?? null,
    via: security?.via ?? null,
    external: security?.external ?? null,
    firstTimeSender: security?.firstTimeSender ?? false,
    replyToMismatch: security?.replyToMismatch ?? null,
    warnings: security?.warnings ?? [],
    authentication: compactAuthentication(response.authentication),
    senderIntel: compactSenderIntel(response.senderIntel),
    unsubscribe: {
      available: Boolean(unsubscribe?.httpsUrl || unsubscribe?.mailto),
      oneClick: unsubscribe?.oneClick ?? false,
      byEmail: Boolean(unsubscribe?.mailto),
      pageUrl: unsubscribe?.httpsUrl ?? null,
    },
  };
}

export function registerMailSafetyTools(
  tool: ScopedToolRegistrar,
  api: AccountApiClient
) {
  tool(MAIL_READ_SCOPE)(
    "get_message_security",
    {
      title: "Get message security assessment",
      description:
        "Summarize whether an incoming message is safe to trust: sender verdict (verified/unverified/suspicious/unavailable), one-line SPF/DKIM/DMARC/ARC results, mailed-by/signed-by/via, whether the sender is external, security warnings (lookalike domain, impersonation, Spamhaus listings, reply-to mismatch), sender server intel (IP, PTR, ASN, country, Spamhaus hits), and whether the message offers an unsubscribe option. Use this before acting on a suspicious message; use get_message_authentication only when the full parsed header data is needed. Blocked/trusted sender state is in get_conversation's per-message `sender` field.",
      inputSchema: messageInputSchema,
      annotations: readOnly,
    },
    ({ mailboxId, messageId }) =>
      runTool(async () =>
        compactSecurity(
          messageId,
          authenticationResponseSchema.parse(
            await api.json(
              apiPath(
                `/mail/messages/${encodeURIComponent(messageId)}/authentication`,
                { mailboxId }
              )
            )
          )
        )
      )
  );

  tool(MAIL_SEND_SCOPE)(
    "unsubscribe_from_mailing_list",
    {
      title: "Unsubscribe from mailing list",
      description:
        'OUTBOUND ACTION: unsubscribe this mailbox from the mailing list that sent an incoming message. With method "auto" the server tries, in order: an RFC 8058 one-click POST to the sender\'s URL (outcome "done"); an unsubscribe email sent from this mailbox, which requires send access (outcome "requested"); otherwise it returns the sender\'s unsubscribe page URL for the user to open themselves (outcome "link"). Method "link" only records that the user is opening the page and returns its URL; it contacts no one. Confirm with the user before calling. Rate-limited to 20 requests per minute. Check get_message_security\'s unsubscribe field first.',
      inputSchema: messageInputSchema.extend({
        method: z.enum(["auto", "link"]).default("auto"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ mailboxId, messageId, method }) =>
      runTool(() =>
        api.json(
          apiPath(
            `/mail/messages/${encodeURIComponent(messageId)}/unsubscribe`,
            { mailboxId }
          ),
          { method: "POST", json: { method } }
        )
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "report_message",
    {
      title: "Report spam",
      description:
        "Report an incoming message as spam: labels it, trains the sender's reputation here and across the workspace, and moves its conversation to Spam. Nothing is sent outside the workspace. Confirm with the user before reporting.",
      inputSchema: messageInputSchema,
      annotations: { ...write, idempotentHint: false },
    },
    ({ mailboxId, messageId }) =>
      runTool(() =>
        api.json(
          apiPath(`/mail/messages/${encodeURIComponent(messageId)}/report`, {
            mailboxId,
          }),
          { method: "POST" }
        )
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "report_conversations",
    {
      title: "Report conversations as spam",
      description:
        "Report the newest incoming message of up to 100 conversations as spam and move them to Spam. Confirm with the user first.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        conversationIds: z
          .array(entityIdSchema)
          .min(1)
          .max(100)
          .transform((ids) => [...new Set(ids)]),
      }),
      annotations: { ...write, idempotentHint: false },
    },
    ({ mailboxId, conversationIds }) =>
      runTool(() =>
        api.json(apiPath("/mail/conversations/report", { mailboxId }), {
          method: "POST",
          json: { conversationIds },
        })
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "mark_message_not_spam",
    {
      title: "Mark message not spam",
      description:
        "Move an incoming message's conversation from Spam back to Inbox, clear its spam label, record the feedback, and mark the sender as trusted in this mailbox. A reply that was kept out of its conversation as spam rejoins it (rejoined: true), and conversationId names the conversation it is in now.",
      inputSchema: messageInputSchema,
      annotations: write,
    },
    ({ mailboxId, messageId }) =>
      runTool(() =>
        api.json(
          apiPath(`/mail/messages/${encodeURIComponent(messageId)}/not-spam`, {
            mailboxId,
          }),
          { method: "POST" }
        )
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "set_sender_trusted",
    {
      title: "Trust or untrust sender",
      description:
        "Mark a sender address as trusted (or not) for everyone using this mailbox. Trusted senders have caution warnings hidden; danger warnings still show.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        address: z.email(),
        trusted: z.boolean(),
      }),
      annotations: write,
    },
    ({ mailboxId, address, trusted }) =>
      runTool(() =>
        api.json(
          `/mail/mailboxes/${encodeURIComponent(mailboxId)}/trusted-senders`,
          { method: "PUT", json: { address, trusted } }
        )
      )
  );

  tool(MAIL_READ_SCOPE)(
    "list_blocked_senders",
    {
      title: "List blocked senders",
      description:
        "List addresses and domains blocked in this mailbox, plus workspace-wide blocks set by administrators (which the mailbox cannot remove).",
      inputSchema: z.object({ mailboxId: mailboxIdSchema }),
      annotations: readOnly,
    },
    ({ mailboxId }) =>
      runTool(() =>
        api.json(
          `/mail/mailboxes/${encodeURIComponent(mailboxId)}/blocked-senders`
        )
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "block_sender",
    {
      title: "Block sender or domain",
      description:
        "Block an address or domain for everyone using this mailbox: future mail from it goes to Spam. With moveExisting, existing conversations from it are also moved to Spam. The mailbox's own address or domain cannot be blocked.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        pattern: blockPatternSchema,
        moveExisting: z.boolean().default(false),
      }),
      annotations: write,
    },
    ({ mailboxId, pattern, moveExisting }) =>
      runTool(() =>
        api.json(
          `/mail/mailboxes/${encodeURIComponent(mailboxId)}/blocked-senders`,
          { method: "POST", json: { pattern, moveExisting } }
        )
      )
  );

  tool(MAIL_ORGANIZE_SCOPE)(
    "unblock_sender",
    {
      title: "Unblock sender or domain",
      description:
        "Remove a mailbox block. Mail already moved to Spam stays there. Workspace-wide blocks can only be removed by an administrator.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        pattern: blockPatternSchema,
      }),
      annotations: write,
    },
    ({ mailboxId, pattern }) =>
      runTool(() =>
        api.json(
          apiPath(
            `/mail/mailboxes/${encodeURIComponent(mailboxId)}/blocked-senders`,
            { pattern }
          ),
          { method: "DELETE" }
        )
      )
  );
}

export function registerAdminSafetyTools(
  tool: ScopedToolRegistrar,
  api: AccountApiClient
) {
  tool(BLOCK_SENDERS_SCOPE)(
    "list_workspace_blocked_senders",
    {
      title: "List senders blocked for everyone",
      description:
        "Administrator: list the addresses and domains blocked for every mailbox in the workspace, with who blocked each and when.",
      annotations: readOnly,
    },
    () => runTool(() => api.json("/admin/blocked-senders"))
  );

  tool(BLOCK_SENDERS_SCOPE)(
    "block_sender_for_workspace",
    {
      title: "Block sender for everyone",
      description:
        "Administrator: block an address or domain for every mailbox in the workspace; its future mail goes to Spam everywhere, and by default (moveExisting) mail already delivered from it is moved to Spam in every mailbox too. Workspace mail domains cannot be blocked. Confirm with the user first.",
      inputSchema: workspaceBlockSchema.safeExtend({
        pattern: blockPatternSchema,
      }),
      annotations: write,
    },
    (input) =>
      runTool(() =>
        api.json("/admin/blocked-senders", {
          method: "POST",
          json: input,
        })
      )
  );

  tool(BLOCK_SENDERS_SCOPE)(
    "unblock_sender_for_workspace",
    {
      title: "Remove workspace-wide block",
      description:
        "Administrator: remove a workspace-wide block. Mailbox-level blocks are unaffected.",
      inputSchema: z.object({ pattern: blockPatternSchema }),
      annotations: write,
    },
    ({ pattern }) =>
      runTool(() =>
        api.json(apiPath("/admin/blocked-senders", { pattern }), {
          method: "DELETE",
        })
      )
  );
}
