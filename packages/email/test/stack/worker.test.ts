import { describe, expect, it } from "bun:test";

import { hashToken } from "@open-workspace/core/module";
import { required } from "@open-workspace/core/shared";
import { poll } from "@open-workspace/core/testing";
import { composerUploadMetaKey } from "@open-workspace/email/worker/mail/uploads.ts";
import { z } from "zod";

import { sessionCookie } from "./cookies.ts";
import { readJson } from "./json.ts";
import {
  env,
  hooks,
  mailbox as mailboxStub,
  useFreshWorkspace,
  worker,
} from "./workspace.ts";

useFreshWorkspace();

/**
 * Lets a queued inbound delivery be processed: runs the mailbox alarm (the
 * stack's own alarms fire too) until the delivery has been attempted once
 * or, with `until: "done"`, is no longer pending.
 */
async function settleInbound(
  mailboxId: string,
  deliveryId: string,
  until: "attempted" | "done" = "done"
) {
  const settled = (row: { attempts: number } | undefined) =>
    !row || (until === "attempted" && row.attempts >= 1);

  const row = await poll(
    async () => {
      await hooks.runAlarm(mailboxId);

      const [pending] = await hooks.mailboxSql<{ attempts: number }>(
        mailboxId,
        "select attempts from pending_inbound where id = ?",
        deliveryId
      );

      return pending;
    },
    settled,
    { timeout: 10_000, interval: 50 }
  );

  if (!settled(row)) {
    throw new Error(`Inbound delivery ${deliveryId} was not processed`);
  }
}

/** Retries an assertion until it holds, like `vi.waitFor`. */
function waitFor(assertion: () => Promise<void>, timeout = 2000) {
  const deadline = Date.now() + timeout;

  const attempt = async (): Promise<void> => {
    try {
      await assertion();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await Bun.sleep(50);

      return attempt();
    }
  };

  return attempt();
}

const createdMailbox = z.looseObject({ mailboxId: z.string() });

const accessLinkBody = z.looseObject({
  accessLink: z.looseObject({ kind: z.string(), url: z.string() }),
});

/** A reply or forward the mail API accepted. */
const composedBody = z.looseObject({
  messageId: z.string(),
  conversationId: z.string(),
  detached: z.boolean(),
});

const listReplyBody = z.looseObject({
  messageId: z.string(),
  detached: z.boolean(),
});

describe("mail worker", () => {
  it("bootstraps the only initial admin and protects mailbox data", async () => {
    const anonymousMail = await worker.fetch(
      "http://example.test/api/mail/mailboxes"
    );

    expect(anonymousMail.status).toBe(401);
    await anonymousMail.json();

    const before = await worker.fetch("http://example.test/api/bootstrap");
    expect(await before.json()).toMatchObject({
      ok: true,
      needsBootstrap: true,
      // The setup form names the mail domains the first address may use.
      setupMailDomains: ["example.test", "secondary.test"],
      authenticated: false,
    });

    const bootstrap = await worker.fetch(
      new Request("http://example.test/api/auth/mock/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Test Admin",
          email: "admin@example.test",
        }),
      })
    );

    expect(bootstrap.status).toBe(200);
    const cookie = sessionCookie(bootstrap);
    await bootstrap.json();

    const mailboxes = await worker.fetch(
      new Request("http://example.test/api/mail/mailboxes", {
        headers: { cookie },
      })
    );

    const mailboxBody = await readJson(
      mailboxes,
      z.looseObject({
        ok: z.literal(true),
        mailboxes: z.array(
          z.looseObject({
            id: z.string(),
            address: z.string(),
            kind: z.string(),
            canSend: z.boolean(),
            unreadCount: z.number(),
          })
        ),
      })
    );

    expect(mailboxBody).toMatchObject({
      ok: true,
      mailboxes: [
        {
          address: "admin@example.test",
          kind: "personal",
          canSend: true,
          unreadCount: 0,
        },
      ],
    });
    const [personalMailbox] = mailboxBody.mailboxes;

    const personalMailboxId = required(
      personalMailbox,
      "the admin has a personal mailbox"
    ).id;

    const adminState = await worker.fetch(
      new Request("http://example.test/api/admin/state", {
        headers: { cookie },
      })
    );

    expect(await adminState.json()).toMatchObject({
      ok: true,
      // The stack's mailDomains, primary first.
      mailDomains: ["example.test", "secondary.test"],
    });

    const defaultAiSettings = await worker.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${personalMailboxId}/ai`,
        { headers: { cookie } }
      )
    );

    expect(await defaultAiSettings.json()).toMatchObject({
      ok: true,
      settings: {
        // The test configuration names no AI model.
        globalEnabled: false,
        configuration: {
          instructions: "",
          confidenceThreshold: 75,
        },
      },
    });

    const updateAiSettings = await worker.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${personalMailboxId}/ai`,
        {
          method: "PUT",
          headers: {
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            instructions: "Prefer Product for launch discussions.",
            confidenceThreshold: 80,
          }),
        }
      )
    );

    expect(await updateAiSettings.json()).toMatchObject({
      ok: true,
      settings: {
        globalEnabled: false,
        configuration: {
          instructions: "Prefer Product for launch discussions.",
          confidenceThreshold: 80,
        },
      },
    });
    await env.MAIL_STORAGE.put(
      "bimi/v1/logo-brand.example.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      {
        customMetadata: {
          status: "ok",
          checkedAt: String(Date.now()),
          reason: "",
        },
      }
    );

    const logo = await worker.fetch(
      new Request("http://example.test/api/mail/bimi/logo-brand.example", {
        headers: { cookie },
      })
    );

    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    expect(logo.headers.get("content-security-policy")).toContain(
      "default-src 'none'"
    );
    await logo.text();

    const missingLogo = await worker.fetch(
      new Request("http://example.test/api/mail/bimi/no-logo.example", {
        headers: { cookie },
      })
    );

    expect(missingLogo.status).toBe(404);
    await missingLogo.text();

    const foldersResponse = await worker.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${personalMailboxId}/folders`,
        { headers: { cookie } }
      )
    );

    const foldersBody = await readJson(
      foldersResponse,
      z.looseObject({
        folders: z.array(
          z.looseObject({ id: z.string(), systemType: z.string().nullable() })
        ),
      })
    );

    expect(foldersBody.folders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "inbox", systemType: "inbox" }),
        expect.objectContaining({ id: "sent", systemType: "sent" }),
      ])
    );

    const adminRow = await env.DB.prepare(
      "SELECT id FROM users WHERE role = 'admin'"
    ).first<{ id: string }>();

    expect(adminRow?.id).toBeTruthy();
    const adminId = required(adminRow, "the bootstrap creates an admin").id;

    const createSecondaryPersonal = await worker.fetch(
      new Request("http://example.test/api/admin/mailboxes", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Test Admin Secondary",
          address: "admin@secondary.test",
          ownerUserId: adminId,
          teamId: null,
        }),
      })
    );

    expect(createSecondaryPersonal.status).toBe(201);

    const secondaryPersonal = await readJson(
      createSecondaryPersonal,
      createdMailbox
    );

    const { rejection: secondaryRejection } = await hooks.email({
      from: "sender@example.net",
      to: "admin@secondary.test",
      raw: "From: Sender <sender@example.net>\r\nTo: admin@secondary.test\r\nSubject: Secondary domain\r\nMessage-ID: <secondary-domain@example.net>\r\n\r\nHello from the second domain.",
    });

    expect(secondaryRejection).toBeUndefined();

    const secondaryRaw = await env.MAIL_STORAGE.list({
      prefix: `mailboxes/${secondaryPersonal.mailboxId}/raw/`,
    });

    expect(secondaryRaw.objects).toHaveLength(1);
    await env.DB.prepare("UPDATE users SET updated_at = 1 WHERE id = ?")
      .bind(adminId)
      .run();

    const setSecondaryPrimary = await worker.fetch(
      new Request(
        `http://example.test/api/admin/mailboxes/${secondaryPersonal.mailboxId}/primary`,
        { method: "POST", headers: { cookie } }
      )
    );

    expect(setSecondaryPrimary.status).toBe(200);
    await setSecondaryPrimary.json();

    const stateWithSecondaryPrimary = await worker.fetch(
      new Request("http://example.test/api/admin/state", {
        headers: { cookie },
      })
    );

    expect(await stateWithSecondaryPrimary.json()).toMatchObject({
      users: [{ personalEmail: "admin@secondary.test" }],
    });

    const userAfterPrimaryChange = await env.DB.prepare(
      "SELECT updated_at AS updatedAt FROM users WHERE id = ?"
    )
      .bind(adminId)
      .first<{ updatedAt: number }>();

    expect(
      required(userAfterPrimaryChange, "the admin is stored").updatedAt
    ).toBeGreaterThan(1);

    const restorePrimary = await worker.fetch(
      new Request(
        `http://example.test/api/admin/mailboxes/${personalMailboxId}/primary`,
        { method: "POST", headers: { cookie } }
      )
    );

    expect(restorePrimary.status).toBe(200);
    await restorePrimary.json();

    const deleteSecondary = await worker.fetch(
      new Request(
        `http://example.test/api/admin/mailboxes/${secondaryPersonal.mailboxId}`,
        { method: "DELETE", headers: { cookie } }
      )
    );

    expect(deleteSecondary.status).toBe(200);
    await deleteSecondary.json();

    // A configured domain stays even with no mailboxes left on it: the config lists it.
    const afterDelete = await worker.fetch(
      new Request("http://example.test/api/admin/state", {
        headers: { cookie },
      })
    );

    expect(await afterDelete.json()).toMatchObject({
      mailDomains: ["example.test", "secondary.test"],
      unlistedMailDomains: [],
    });

    const createTeam = await worker.fetch(
      new Request("http://example.test/api/admin/teams", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Support",
          slug: "support",
          description: null,
          members: [{ userId: adminId, canSend: true }],
        }),
      })
    );

    expect(createTeam.status).toBe(201);

    const { teamId } = await readJson(
      createTeam,
      z.looseObject({ teamId: z.string() })
    );

    const createShared = await worker.fetch(
      new Request("http://example.test/api/admin/mailboxes", {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          displayName: "Support",
          address: "support@example.test",
          ownerUserId: null,
          teamId,
        }),
      })
    );

    expect(createShared.status).toBe(201);

    const { mailboxId: sharedMailboxId } = await readJson(
      createShared,
      createdMailbox
    );

    const createInvitation = await worker.fetch(
      new Request("http://example.test/api/admin/invitations", {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Invited User",
          email: "invited@example.test",
        }),
      })
    );

    expect(createInvitation.status).toBe(201);

    const invitationBody = await readJson(
      createInvitation,
      z.looseObject({ accessLink: z.looseObject({ userId: z.string() }) })
    );

    const updateMailbox = await worker.fetch(
      new Request(
        `http://example.test/api/admin/mailboxes/${sharedMailboxId}`,
        {
          method: "PATCH",
          headers: {
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ displayName: "Customer support" }),
        }
      )
    );

    expect(updateMailbox.status).toBe(200);
    await updateMailbox.json();

    // Joining the team is what gives the invited person the mailbox.
    const updateTeam = await worker.fetch(
      new Request(`http://example.test/api/admin/teams/${teamId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Support",
          slug: "support",
          description: null,
          members: [
            { userId: adminId, canSend: true },
            { userId: invitationBody.accessLink.userId, canSend: false },
          ],
        }),
      })
    );

    expect(updateTeam.status).toBe(200);
    await updateTeam.json();

    const updateUser = await worker.fetch(
      new Request(
        `http://example.test/api/admin/users/${invitationBody.accessLink.userId}`,
        {
          method: "PATCH",
          headers: {
            cookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Invited User Updated",
          }),
        }
      )
    );

    expect(updateUser.status).toBe(200);
    await updateUser.json();

    const renamedPersonalMailbox = await env.DB.prepare(
      "SELECT display_name AS displayName FROM mailboxes WHERE owner_user_id = ? AND is_primary = 1"
    )
      .bind(invitationBody.accessLink.userId)
      .first<{ displayName: string }>();

    expect(renamedPersonalMailbox).toEqual({
      displayName: "Invited User Updated",
    });

    const storedMembership = await env.DB.prepare(
      "SELECT can_send AS canSend FROM mailbox_access WHERE user_id = ? AND mailbox_id = ?"
    )
      .bind(invitationBody.accessLink.userId, sharedMailboxId)
      .first<{ canSend: number }>();

    expect(storedMembership).toEqual({ canSend: 0 });

    const replacementInvitation = await worker.fetch(
      new Request(
        `http://example.test/api/admin/users/${invitationBody.accessLink.userId}/access-link`,
        { method: "POST", headers: { cookie } }
      )
    );

    expect(replacementInvitation.status).toBe(201);

    const replacementInvitationBody = await readJson(
      replacementInvitation,
      accessLinkBody
    );

    expect(replacementInvitationBody.accessLink.kind).toBe("invitation");
    expect(new URL(replacementInvitationBody.accessLink.url).pathname).toMatch(
      /^\/invite\//u
    );

    const recovery = await worker.fetch(
      new Request(
        `http://example.test/api/admin/users/${adminId}/access-link`,
        {
          method: "POST",
          headers: { cookie },
        }
      )
    );

    expect(recovery.status).toBe(201);

    const recoveryBody = await readJson(recovery, accessLinkBody);

    expect(recoveryBody.accessLink.kind).toBe("recovery");

    const recoveryToken = new URL(recoveryBody.accessLink.url).pathname
      .split("/")
      .at(-1);

    expect(recoveryToken).toBeTruthy();
    const recoveryTokenValue = required(recoveryToken, "the link has a token");

    const recoveryPreview = await worker.fetch(
      `http://example.test/api/auth/recovery/${recoveryToken}`
    );

    expect(recoveryPreview.status).toBe(200);
    expect(await recoveryPreview.json()).toMatchObject({
      ok: true,
      accessLink: { name: "Test Admin", email: "admin@example.test" },
    });

    const recoveryOptions = await worker.fetch(
      new Request(
        `http://example.test/api/auth/recovery/${recoveryToken}/options`,
        {
          method: "POST",
        }
      )
    );

    expect(recoveryOptions.status).toBe(200);
    await recoveryOptions.json();

    const firstRecoveryLink = await env.DB.prepare(
      "SELECT id FROM access_links WHERE token_hash = ?"
    )
      .bind(await hashToken(recoveryTokenValue))
      .first<{ id: string }>();

    expect(firstRecoveryLink?.id).toBeTruthy();

    const firstRecoveryLinkId = required(
      firstRecoveryLink,
      "the recovery link is stored"
    ).id;

    const replacementRecovery = await worker.fetch(
      new Request(
        `http://example.test/api/admin/users/${adminId}/access-link`,
        { method: "POST", headers: { cookie } }
      )
    );

    expect(replacementRecovery.status).toBe(201);

    const replacementBody = await readJson(replacementRecovery, accessLinkBody);

    const replacementToken = new URL(replacementBody.accessLink.url).pathname
      .split("/")
      .at(-1);

    expect(replacementToken).toBeTruthy();
    expect(
      (
        await worker.fetch(
          `http://example.test/api/auth/recovery/${recoveryToken}`
        )
      ).status
    ).toBe(404);

    const abandonedChallenges = await env.DB.prepare(
      "SELECT count(*) AS count FROM auth_challenges WHERE access_link_id = ?"
    )
      .bind(firstRecoveryLinkId)
      .first<{ count: number }>();

    expect(abandonedChallenges?.count).toBe(0);

    const activeRecoveryLinks = await env.DB.prepare(
      "SELECT count(*) AS count FROM access_links WHERE user_id = ? AND kind = 'recovery' AND consumed_at IS NULL"
    )
      .bind(adminId)
      .first<{ count: number }>();

    expect(activeRecoveryLinks?.count).toBe(1);

    const inboundDeliveryId = "inbound-alarm-test";
    const inboundObjectKey = "test/inbound-alarm.eml";
    const inboundReceivedAt = Date.now();

    const inboundRaw =
      "From: Alarm Sender <alarm@example.net>\r\nTo: admin@example.test\r\nSubject: Alarm inbound\r\nDate: Thu, 1 Jan 2099 00:00:00 +0000\r\nMessage-ID: <alarm-inbound@example.net>\r\n\r\nPersisted by the mailbox alarm.";

    await env.MAIL_STORAGE.put(inboundObjectKey, inboundRaw);
    const mailbox = mailboxStub(personalMailboxId);
    await expect(
      mailbox.enqueueInbound({
        id: inboundDeliveryId,
        mailboxId: personalMailboxId,
        rawObjectKey: inboundObjectKey,
        envelopeFrom: "alarm@example.net",
        envelopeTo: "admin@example.test",
        receivedAt: inboundReceivedAt,
      })
    ).resolves.toEqual({
      messageId: `msg_${inboundDeliveryId}`,
      queued: true,
    });
    await settleInbound(personalMailboxId, inboundDeliveryId);

    const inboundMessage = required(
      await mailbox.getEmailByMessageId("<alarm-inbound@example.net>"),
      "the alarm stores the inbound mail"
    );

    expect(inboundMessage.subject).toBe("Alarm inbound");
    expect(inboundMessage.bodyText?.trim()).toBe(
      "Persisted by the mailbox alarm."
    );
    expect(inboundMessage.transportState).toBe("received");
    expect(inboundMessage.timelineAt.getTime()).toBe(inboundReceivedAt);

    const inboundConversation = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations/${inboundMessage.conversationId}?mailboxId=${personalMailboxId}`,
        { headers: { cookie } }
      )
    );

    expect(inboundConversation.status).toBe(200);
    expect(await inboundConversation.json()).toMatchObject({
      messages: [{ id: inboundMessage.id, hasOriginal: true }],
    });

    const original = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/${inboundMessage.id}/original?mailboxId=${personalMailboxId}`,
        { headers: { cookie } }
      )
    );

    expect(original.status).toBe(200);
    expect(original.headers.get("content-type")).toContain("text/plain");
    expect(original.headers.get("content-disposition")).toContain("inline");
    expect(await original.text()).toBe(inboundRaw);

    const suffixLength = 12;

    const originalSuffix = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/${inboundMessage.id}/original?mailboxId=${personalMailboxId}`,
        {
          headers: {
            cookie,
            range: `bytes=-${suffixLength}`,
          },
        }
      )
    );

    expect(originalSuffix.status).toBe(206);
    expect(originalSuffix.headers.get("content-length")).toBe(
      String(suffixLength)
    );
    expect(originalSuffix.headers.get("content-range")).toBe(
      `bytes ${inboundRaw.length - suffixLength}-${inboundRaw.length - 1}/${inboundRaw.length}`
    );
    expect(await originalSuffix.text()).toBe(inboundRaw.slice(-suffixLength));

    const openRangeOffset = 10;

    const originalTail = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/${inboundMessage.id}/original?mailboxId=${personalMailboxId}`,
        {
          headers: {
            cookie,
            range: `bytes=${openRangeOffset}-`,
          },
        }
      )
    );

    expect(originalTail.status).toBe(206);
    expect(originalTail.headers.get("content-length")).toBe(
      String(inboundRaw.length - openRangeOffset)
    );
    expect(originalTail.headers.get("content-range")).toBe(
      `bytes ${openRangeOffset}-${inboundRaw.length - 1}/${inboundRaw.length}`
    );
    expect(await originalTail.text()).toBe(inboundRaw.slice(openRangeOffset));

    const authentication = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/${inboundMessage.id}/authentication?mailboxId=${personalMailboxId}`,
        { headers: { cookie } }
      )
    );

    expect(authentication.status).toBe(200);
    expect(await authentication.json()).toMatchObject({
      ok: true,
      authentication: {
        source: "headers",
        verdict: "unavailable",
        verdictReason: "not_cloudflare",
      },
      security: { verdict: "unavailable", external: true },
      original: {
        subject: "Alarm inbound",
        from: "alarm@example.net",
        to: ["admin@example.test"],
        messageId: "<alarm-inbound@example.net>",
      },
    });
    await expect(
      mailbox.enqueueInbound({
        id: inboundDeliveryId,
        mailboxId: personalMailboxId,
        rawObjectKey: inboundObjectKey,
        envelopeFrom: "alarm@example.net",
        envelopeTo: "admin@example.test",
        receivedAt: inboundReceivedAt,
      })
    ).resolves.toEqual({
      messageId: inboundMessage.id,
      queued: false,
    });

    const htmlDeliveryId = "inbound-html-only";
    const htmlObjectKey = "test/inbound-html-only.eml";
    await env.MAIL_STORAGE.put(
      htmlObjectKey,
      [
        "From: Auth <auth@example.net>",
        "To: admin@example.test",
        "Subject: Your code",
        "Message-ID: <html-only@example.net>",
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<html><body><p>Your one-time code is <strong>482901</strong></p></body></html>",
      ].join("\r\n")
    );
    await mailbox.enqueueInbound({
      id: htmlDeliveryId,
      mailboxId: personalMailboxId,
      rawObjectKey: htmlObjectKey,
      envelopeFrom: "auth@example.net",
      envelopeTo: "admin@example.test",
      receivedAt: inboundReceivedAt + 1,
    });
    await settleInbound(personalMailboxId, htmlDeliveryId);

    const htmlMessage = required(
      await mailbox.getEmailByMessageId("<html-only@example.net>"),
      "the alarm stores the HTML-only mail"
    );

    expect(htmlMessage.bodyText).toContain("482901");
    expect(htmlMessage.bodyHtmlR2Key).toBeTruthy();

    const htmlConversation = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations/${htmlMessage.conversationId}?mailboxId=${personalMailboxId}`,
        { headers: { cookie } }
      )
    );

    expect(htmlConversation.status).toBe(200);
    expect(await htmlConversation.json()).toMatchObject({
      messages: [
        {
          id: htmlMessage.id,
          bodyHtml: expect.stringContaining("<strong>482901</strong>"),
        },
      ],
    });

    const retriedDeliveryId = "inbound-alarm-retry";
    const retriedObjectKey = "test/inbound-alarm-retry.eml";
    await mailbox.enqueueInbound({
      id: retriedDeliveryId,
      mailboxId: personalMailboxId,
      rawObjectKey: retriedObjectKey,
      envelopeFrom: "retry@example.net",
      envelopeTo: "admin@example.test",
      receivedAt: inboundReceivedAt + 1,
    });
    await settleInbound(personalMailboxId, retriedDeliveryId, "attempted");

    const [pendingRetry] = await hooks.mailboxSql<{ attempts: number }>(
      personalMailboxId,
      "select attempts from pending_inbound where id = ?",
      retriedDeliveryId
    );

    expect(
      required(pendingRetry, "the delivery is still pending").attempts
    ).toBe(1);
    await expect(
      mailbox.getEmail(`msg_${retriedDeliveryId}`)
    ).resolves.toBeNull();
    await env.MAIL_STORAGE.put(
      retriedObjectKey,
      "From: Retry Sender <retry@example.net>\r\nTo: admin@example.test\r\nSubject: Retried inbound\r\nMessage-ID: <retried-inbound@example.net>\r\n\r\nAvailable after the first alarm."
    );
    await hooks.mailboxSql(
      personalMailboxId,
      "update pending_inbound set next_attempt_at = 0 where id = ?",
      retriedDeliveryId
    );
    await settleInbound(personalMailboxId, retriedDeliveryId);
    await expect(
      mailbox.getEmail(`msg_${retriedDeliveryId}`)
    ).resolves.toMatchObject({
      subject: "Retried inbound",
      bodyText: expect.stringContaining("Available after the first alarm"),
      transportState: "received",
    });
    const unavailableDeliveryId = "inbound-storage-unavailable";
    await mailbox.enqueueInbound({
      id: unavailableDeliveryId,
      mailboxId: personalMailboxId,
      rawObjectKey: "test/inbound-storage-unavailable.eml",
      envelopeFrom: "unavailable@example.net",
      envelopeTo: "admin@example.test",
      receivedAt: Date.now() - 24 * 60 * 60 * 1000 - 1,
    });
    await settleInbound(personalMailboxId, unavailableDeliveryId);
    await expect(
      mailbox.getEmail(`msg_${unavailableDeliveryId}`)
    ).resolves.toMatchObject({
      subject: "(unreadable message)",
      bodyText: expect.stringContaining("remained unavailable for 24 hours"),
      rawMimeR2Key: null,
      transportState: "received",
    });

    const searchResponse = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations?mailboxId=${personalMailboxId}&folder=inbox&search=Persisted`,
        { headers: { cookie } }
      )
    );

    expect(searchResponse.status).toBe(200);
    expect(await searchResponse.json()).toMatchObject({
      conversations: [{ conversationId: inboundMessage.conversationId }],
    });

    const conversationResponse = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations/${inboundMessage.conversationId}?mailboxId=${personalMailboxId}`,
        { headers: { cookie } }
      )
    );

    expect(conversationResponse.status).toBe(200);
    expect(await conversationResponse.json()).toMatchObject({
      ok: true,
      messages: [
        {
          id: inboundMessage.id,
          quotedText: null,
          replyPlan: {
            defaultMode: "reply",
            isGroup: false,
            actions: [
              {
                mode: "reply",
                to: ["alarm@example.net"],
                cc: [],
              },
            ],
          },
        },
      ],
    });

    const replyRequestId = crypto.randomUUID();

    const replyPayload = {
      requestId: replyRequestId,
      mailboxId: personalMailboxId,
      mode: "reply",
      cc: [],
      bcc: [],
      bodyText: "A regular reply.",
    };

    const replyResponse = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/${inboundMessage.id}/replies`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(replyPayload),
        }
      )
    );

    expect(replyResponse.status).toBe(201);

    const replyBody = await readJson(
      replyResponse,
      z.looseObject({
        messageId: z.string(),
        conversationId: z.string(),
        transportError: z.string().nullable(),
      })
    );

    expect(replyBody.transportError).toBeNull();
    const storedReply = await mailbox.getEmail(replyBody.messageId);
    expect(storedReply).toMatchObject({
      conversationId: inboundMessage.conversationId,
      inReplyToJson: ["<alarm-inbound@example.net>"],
      referencesJson: ["<alarm-inbound@example.net>"],
    });

    const duplicateReply = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/${inboundMessage.id}/replies`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(replyPayload),
        }
      )
    );

    expect(duplicateReply.status).toBe(200);
    expect(await duplicateReply.json()).toMatchObject({
      messageId: replyBody.messageId,
      conversationId: replyBody.conversationId,
    });
    expect(
      (await mailbox.getConversation(replyBody.conversationId)).filter(
        (message) => message.id === replyBody.messageId
      )
    ).toHaveLength(1);

    const outboundMessageId = "msg_alarm_outbound";
    const timestamp = new Date();
    const outboundAttachmentKey = `mailboxes/${personalMailboxId}/messages/${outboundMessageId}/attachments/att_alarm`;
    await env.MAIL_STORAGE.put(
      outboundAttachmentKey,
      new TextEncoder().encode("alarm attachment"),
      { httpMetadata: { contentType: "text/plain" } }
    );
    await mailbox.submitOutgoing({
      id: outboundMessageId,
      requestFingerprint: "alarm-outbound-request",
      conversationId: "conv_alarm_outbound",
      direction: "outgoing",
      fromJson: [{ address: "admin@example.test", name: "Test Admin" }],
      toJson: [{ address: "recipient@example.net", name: null }],
      subject: "Alarm outbound",
      preview: "Outbound alarm body",
      bodyText: "Outbound alarm body",
      attachmentsJson: [
        {
          id: "att_alarm",
          r2Key: outboundAttachmentKey,
          filename: "alarm.txt",
          contentType: "text/plain",
          size: 16,
          contentId: null,
          disposition: "attachment",
          delivery: "attached",
          downloadTokenHash: null,
          downloadExpiresAt: null,
        },
      ],
      timelineAt: timestamp,
      transportState: "unconfirmed",
    });
    const outboundMessage = await mailbox.getEmail(outboundMessageId);
    expect(outboundMessage?.transportState).toBe("submitted");
    expect(outboundMessage?.timelineAt).toEqual(timestamp);

    const unconfirmedMessageId = "msg_unconfirmed_outbound";
    await mailbox.insertEmail({
      id: unconfirmedMessageId,
      requestFingerprint: "unconfirmed-outbound-request",
      conversationId: "conv_alarm_outbound",
      direction: "outgoing",
      fromJson: [{ address: "admin@example.test", name: "Test Admin" }],
      toJson: [{ address: "recipient@example.net", name: null }],
      subject: "Unconfirmed outbound",
      preview: "Resend only after explicit confirmation",
      bodyText: "Resend only after explicit confirmation",
      timelineAt: new Date(),
      transportState: "unconfirmed",
    });

    const unconfirmedMessage = required(
      await mailbox.getEmail(unconfirmedMessageId),
      "the unconfirmed message is stored"
    );

    const idempotentReplay = await mailbox.submitOutgoing(unconfirmedMessage);
    expect(idempotentReplay).toMatchObject({
      outcome: "existing",
      email: { transportState: "unconfirmed" },
    });
    const resentMessage = await mailbox.resendOutgoing(unconfirmedMessageId);
    expect(resentMessage?.transportState).toBe("submitted");

    const failedMessageId = "msg_failed_outbound";

    const failedSubmission = await mailbox.submitOutgoing({
      id: failedMessageId,
      requestFingerprint: "failed-outbound-request",
      conversationId: "conv_alarm_outbound",
      direction: "outgoing",
      fromJson: [{ address: "admin@example.test", name: "Test Admin" }],
      toJson: [{ address: "recipient@example.net", name: null }],
      subject: "Failed outbound preparation",
      preview: "Missing attachment",
      bodyText: "Missing attachment",
      attachmentsJson: [
        {
          id: "att_missing",
          r2Key: "missing/outbound-attachment",
          filename: "missing.txt",
          contentType: "text/plain",
          size: 1,
          contentId: null,
          disposition: "attachment",
          delivery: "attached",
          downloadTokenHash: null,
          downloadExpiresAt: null,
        },
      ],
      timelineAt: new Date(),
      transportState: "unconfirmed",
    });

    expect(failedSubmission.email).toMatchObject({
      transportState: "failed",
      transportError: "Attachment missing.txt is missing",
    });
    expect(await mailbox.resendOutgoing(failedMessageId)).toMatchObject({
      transportState: "failed",
    });

    async function sentPage(cursor?: string) {
      const url = new URL("http://example.test/api/mail/conversations");
      url.searchParams.set("mailboxId", personalMailboxId);
      url.searchParams.set("folder", "sent");
      url.searchParams.set("limit", "1");

      if (cursor) url.searchParams.set("cursor", cursor);

      const response = await worker.fetch(
        new Request(url, { headers: { cookie } })
      );

      expect(response.status).toBe(200);

      return readJson(
        response,
        z.looseObject({
          conversations: z.array(z.looseObject({ conversationId: z.string() })),
          nextCursor: z.string().nullable(),
        })
      );
    }

    const sentFirst = await sentPage();
    expect(sentFirst.conversations).toHaveLength(1);
    expect(sentFirst.nextCursor).toBeTruthy();

    const sentSecond = await sentPage(
      required(sentFirst.nextCursor, "the first page has a cursor")
    );

    expect(sentSecond.conversations).toHaveLength(1);
    expect(sentSecond.nextCursor).toBeNull();
    expect(
      new Set(
        [...sentFirst.conversations, ...sentSecond.conversations].map(
          (conversation) => conversation.conversationId
        )
      ).size
    ).toBe(2);

    const forwardResponse = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/${outboundMessageId}/forward`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            mailboxId: personalMailboxId,
            to: ["forward-recipient@example.net"],
            cc: [],
            bcc: [],
            bodyText: "Please review this message.",
          }),
        }
      )
    );

    expect(forwardResponse.status).toBe(201);

    const forwardBody = await readJson(forwardResponse, composedBody);

    const forwardedMessage = required(
      await mailbox.getEmail(forwardBody.messageId),
      "the forward is stored"
    );

    // Read before matching: bun's toMatchObject leaves asymmetric matchers in the received arrays.
    const forwardedAttachment = required(
      forwardedMessage.attachmentsJson[0],
      "the forward carries the attachment"
    );

    const forwardedBodyText = forwardedMessage.bodyText;
    expect(forwardedMessage).toMatchObject({
      bodyText: expect.stringContaining("Forwarded message"),
      attachmentsJson: [
        expect.objectContaining({
          id: "fwd_att_1",
          filename: "alarm.txt",
        }),
      ],
    });
    expect(forwardedAttachment.r2Key).not.toBe(outboundAttachmentKey);
    expect(await env.MAIL_STORAGE.get(outboundAttachmentKey)).not.toBeNull();
    expect(
      await env.MAIL_STORAGE.get(forwardedAttachment.r2Key).then((object) =>
        object?.text()
      )
    ).toBe("alarm attachment");
    expect(forwardedBodyText).toContain("Outbound alarm body");

    const contextResponse = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/${inboundMessage.id}/replies`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            mailboxId: personalMailboxId,
            mode: "reply",
            cc: ["new-participant@example.net"],
            bcc: [],
            bodyText: "Adding someone who needs the context.",
            bodyHtml:
              "<p><strong>Adding someone who needs the context.</strong></p>",
          }),
        }
      )
    );

    expect(contextResponse.status).toBe(201);

    const contextBody = await readJson(contextResponse, composedBody);

    expect(contextBody).toMatchObject({
      conversationId: inboundMessage.conversationId,
      detached: false,
    });
    const contextMessage = await mailbox.getEmail(contextBody.messageId);
    expect(contextMessage).toMatchObject({
      bodyText: "Adding someone who needs the context.",
      quotedText: expect.stringContaining("Persisted by the mailbox alarm."),
    });

    const storedContextHtml = contextMessage?.bodyHtmlR2Key
      ? await env.MAIL_STORAGE.get(contextMessage.bodyHtmlR2Key).then(
          (object) => object?.text()
        )
      : null;

    expect(storedContextHtml).toBe(
      "<p><strong>Adding someone who needs the context.</strong></p>"
    );

    const contextDeliveryHtml = await hooks.call<string>(
      "worker.outboundDeliveryHtml",
      personalMailboxId,
      contextBody.messageId
    );

    expect(contextDeliveryHtml).toContain(
      "<strong>Adding someone who needs the context.</strong>"
    );
    expect(contextDeliveryHtml).toContain("Persisted by the mailbox alarm.");

    const groupParentId = "msg_group_parent";
    const groupParentAt = new Date();
    await mailbox.insertEmail({
      id: groupParentId,
      conversationId: "conv_group_parent",
      direction: "incoming",
      messageIdHeader: "<group-parent@example.net>",
      fromJson: [{ address: "anna@example.net", name: "Anna" }],
      toJson: [{ address: "admin@example.test", name: null }],
      ccJson: [{ address: "boris@example.net", name: "Boris" }],
      subject: "Group parent",
      preview: "Visible to Anna, Boris, and the mailbox.",
      bodyText: "Visible to Anna, Boris, and the mailbox.",
      timelineAt: groupParentAt,
      transportState: "received",
    });

    const privateFromGroupResponse = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/${groupParentId}/replies`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            mailboxId: personalMailboxId,
            mode: "reply",
            cc: [],
            bcc: [],
            bodyText: "This is private.",
          }),
        }
      )
    );

    expect(privateFromGroupResponse.status).toBe(201);

    const privateFromGroup = await readJson(
      privateFromGroupResponse,
      composedBody
    );

    expect(privateFromGroup).toMatchObject({ detached: true });
    expect(privateFromGroup.conversationId).not.toBe("conv_group_parent");
    expect(await mailbox.getEmail(privateFromGroup.messageId)).toMatchObject({
      inReplyToJson: ["<group-parent@example.net>"],
    });

    const listParentId = "msg_list_parent";
    await mailbox.insertEmail({
      id: listParentId,
      conversationId: "conv_list_parent",
      direction: "incoming",
      messageIdHeader: "<list-parent@example.net>",
      fromJson: [{ address: "author@example.net", name: "List Author" }],
      toJson: [{ address: "admin@example.test", name: null }],
      subject: "List parent",
      timelineAt: new Date(),
      transportState: "received",
      listId: "workers.example.net",
      listPostAddress: "workers@example.net",
    });

    const listReplyResponse = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/${listParentId}/replies`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            mailboxId: personalMailboxId,
            mode: "reply_list",
            cc: [],
            bcc: [],
            bodyText: "Replying to the list.",
          }),
        }
      )
    );

    expect(listReplyResponse.status).toBe(201);

    const listReply = await readJson(listReplyResponse, listReplyBody);

    expect(listReply.detached).toBe(false);
    expect(await mailbox.getEmail(listReply.messageId)).toMatchObject({
      listId: "workers.example.net",
      listPostAddress: "workers@example.net",
    });

    const privateListReplyResponse = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/${listParentId}/replies`,
        {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            mailboxId: personalMailboxId,
            mode: "reply",
            cc: [],
            bcc: [],
            bodyText: "Replying privately to the author.",
          }),
        }
      )
    );

    expect(privateListReplyResponse.status).toBe(201);

    const privateListReply = await readJson(
      privateListReplyResponse,
      listReplyBody
    );

    expect(privateListReply.detached).toBe(true);
    expect(await mailbox.getEmail(privateListReply.messageId)).toMatchObject({
      listId: null,
      listPostAddress: null,
    });

    const archiveConversation = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations/bulk?mailboxId=${personalMailboxId}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            type: "update",
            conversationIds: [inboundMessage.conversationId],
            sourceFolderId: "inbox",
            update: { mailboxState: "archive" },
          }),
        }
      )
    );

    expect(archiveConversation.status).toBe(200);
    await archiveConversation.json();

    const archivedConversation = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations/${inboundMessage.conversationId}?mailboxId=${personalMailboxId}`,
        { headers: { cookie } }
      )
    );

    expect(await archivedConversation.json()).toMatchObject({
      mailboxState: "archive",
    });

    const restoreConversation = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations/bulk?mailboxId=${personalMailboxId}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            type: "update",
            conversationIds: [inboundMessage.conversationId],
            sourceFolderId: "archive",
            update: { mailboxState: "active" },
          }),
        }
      )
    );

    expect(restoreConversation.status).toBe(200);
    await restoreConversation.json();

    const invalidCursor = await worker.fetch(
      new Request(
        `http://example.test/api/mail/conversations?mailboxId=${personalMailboxId}&folder=sent&cursor=not-a-cursor`,
        { headers: { cookie } }
      )
    );

    expect(invalidCursor.status).toBe(400);
    await invalidCursor.json();

    const concurrentRequestId = crypto.randomUUID();

    async function uploadAttachment(filename: string, body: string) {
      const intentResponse = await worker.fetch(
        new Request(
          `http://example.test/api/mail/uploads?mailboxId=${personalMailboxId}`,
          {
            method: "POST",
            headers: {
              cookie,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              filename,
              contentType: "text/plain",
              size: new TextEncoder().encode(body).byteLength,
            }),
          }
        )
      );

      expect(intentResponse.status).toBe(201);

      const intent = await readJson(
        intentResponse,
        z.looseObject({
          upload: z.looseObject({
            id: z.string(),
            uploadUrl: z.string(),
            headers: z.record(z.string(), z.string()),
          }),
        })
      );

      // Straight to the bucket's local S3 endpoint, as a browser would.
      const put = await fetch(intent.upload.uploadUrl, {
        method: "PUT",
        headers: intent.upload.headers,
        body,
      });

      expect(put.status).toBe(200);
      await put.arrayBuffer();

      const complete = await worker.fetch(
        new Request(
          `http://example.test/api/mail/uploads/${intent.upload.id}/complete?mailboxId=${personalMailboxId}`,
          {
            method: "POST",
            headers: { cookie },
          }
        )
      );

      expect(complete.status).toBe(200);
      await complete.json();

      return intent.upload.id;
    }

    const uploadA = await uploadAttachment(
      "request-a.txt",
      "attachment from request A"
    );

    const uploadB = await uploadAttachment(
      "request-b.txt",
      "attachment from request B"
    );

    const attachmentPreflight = await worker.fetch(
      new Request("http://example.test/api/mail/attachment-preflight", {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "compose",
          mailboxId: personalMailboxId,
          subject: "Attachment preflight",
          bodyText: "Small attachment",
          attachments: [{ uploadId: uploadA }],
        }),
      })
    );

    expect(attachmentPreflight.status).toBe(200);
    expect(await attachmentPreflight.json()).toMatchObject({
      linkedUploadIds: [],
      externalizedAttachments: 0,
    });

    const concurrentPayloads = [
      {
        requestId: concurrentRequestId,
        mailboxId: personalMailboxId,
        to: ["CaseSensitive@Example.NET"],
        subject: "Concurrent request A",
        bodyText: "Body from request A",
        attachments: [{ uploadId: uploadA }],
      },
      {
        requestId: concurrentRequestId,
        mailboxId: personalMailboxId,
        to: ["CaseSensitive@Example.NET"],
        subject: "Concurrent request B",
        bodyText: "Body from request B",
        attachments: [{ uploadId: uploadB }],
      },
    ];

    const concurrentResponses = await Promise.all(
      concurrentPayloads.map((payload) =>
        worker.fetch(
          new Request("http://example.test/api/mail/messages", {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        )
      )
    );

    const concurrentResults = await Promise.all(
      concurrentResponses.map(async (response) => ({
        status: response.status,
        body: await readJson(
          response,
          z.looseObject({ messageId: z.string().optional() })
        ),
      }))
    );

    expect(concurrentResults.map((result) => result.status).sort()).toEqual([
      201, 409,
    ]);

    const winnerIndex = concurrentResults.findIndex(
      (result) => result.status === 201
    );

    const winner = required(concurrentResults[winnerIndex], "one request wins");

    const winnerPayload = required(
      concurrentPayloads[winnerIndex],
      "the winner's payload"
    );

    const concurrentEmail = required(
      await mailbox.getEmail(
        required(winner.body.messageId, "the winner names its message")
      ),
      "the winner's message is stored"
    );

    expect(concurrentEmail).toMatchObject({
      subject: winnerPayload.subject,
      bodyText: winnerPayload.bodyText,
      toJson: [{ address: "CaseSensitive@example.net", name: null }],
    });

    const concurrentAttachment = required(
      concurrentEmail.attachmentsJson[0],
      "the winner's attachment"
    );

    const concurrentObject = await env.MAIL_STORAGE.get(
      concurrentAttachment.r2Key
    );

    expect(await concurrentObject?.text()).toBe(
      `attachment from request ${winnerIndex === 0 ? "A" : "B"}`
    );
    const winnerUpload = winnerIndex === 0 ? uploadA : uploadB;
    const losingUpload = winnerIndex === 0 ? uploadB : uploadA;
    await waitFor(async () => {
      expect(
        await env.MAIL_STORAGE.head(
          composerUploadMetaKey(personalMailboxId, adminId, winnerUpload)
        )
      ).toBeNull();
    }, 2000);
    expect(
      await env.MAIL_STORAGE.head(
        composerUploadMetaKey(personalMailboxId, adminId, losingUpload)
      )
    ).not.toBeNull();
    await hooks.call("worker.discardComposerUploads", {
      mailboxId: personalMailboxId,
      userId: adminId,
      uploadIds: [losingUpload],
    });

    const publicMessageId = "msg_public_download";
    const publicAttachmentId = "att_public_download";
    const inlineImageId = "att_inline_image";
    const unsafeInlineId = "att_unsafe_inline";
    const publicToken = `${personalMailboxId}.${publicMessageId}.${publicAttachmentId}.public-secret`;
    const publicObjectKey = `mailboxes/${personalMailboxId}/messages/${publicMessageId}/attachments/${publicAttachmentId}`;
    const inlineImageKey = `mailboxes/${personalMailboxId}/messages/${publicMessageId}/attachments/${inlineImageId}`;
    const unsafeInlineKey = `mailboxes/${personalMailboxId}/messages/${publicMessageId}/attachments/${unsafeInlineId}`;
    await env.MAIL_STORAGE.put(publicObjectKey, "public download body");
    await env.MAIL_STORAGE.put(
      inlineImageKey,
      new Uint8Array([137, 80, 78, 71])
    );
    await env.MAIL_STORAGE.put(unsafeInlineKey, "<script>alert(1)</script>");
    await mailbox.insertEmail({
      id: publicMessageId,
      conversationId: "conv_public_download",
      direction: "outgoing",
      fromJson: [{ address: "admin@example.test", name: "Test Admin" }],
      toJson: [{ address: "external@example.net", name: null }],
      subject: "Public download",
      timelineAt: timestamp,
      transportState: "submitted",
      attachmentsJson: [
        {
          id: publicAttachmentId,
          r2Key: publicObjectKey,
          filename: "public.txt",
          contentType: "text/plain",
          size: 20,
          contentId: null,
          disposition: "attachment",
          delivery: "download_link",
          downloadTokenHash: await hashToken(publicToken),
          downloadExpiresAt: Date.now() + 60_000,
        },
        {
          id: inlineImageId,
          r2Key: inlineImageKey,
          filename: "pixel.png",
          contentType: "image/png",
          size: 4,
          contentId: "pixel@example.test",
          disposition: "inline",
          delivery: "attached",
          downloadTokenHash: null,
          downloadExpiresAt: null,
        },
        {
          id: unsafeInlineId,
          r2Key: unsafeInlineKey,
          filename: "unsafe.html",
          contentType: "text/html",
          size: 25,
          contentId: "unsafe@example.test",
          disposition: "inline",
          delivery: "attached",
          downloadTokenHash: null,
          downloadExpiresAt: null,
        },
      ],
    });

    const publicDownload = await worker.fetch(
      `http://example.test/api/downloads/mail/${publicToken}`
    );

    expect(publicDownload.status).toBe(200);
    expect(await publicDownload.text()).toBe("public download body");

    const authenticatedDownload = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/${publicMessageId}/attachments/${unsafeInlineId}?mailboxId=${personalMailboxId}`,
        { headers: { cookie } }
      )
    );

    expect(authenticatedDownload.status).toBe(200);
    expect(authenticatedDownload.headers.get("content-disposition")).toContain(
      "attachment"
    );
    expect(await authenticatedDownload.text()).toContain("<script>");

    const inlineImage = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/${publicMessageId}/attachments/${inlineImageId}/inline?mailboxId=${personalMailboxId}`,
        { headers: { cookie } }
      )
    );

    expect(inlineImage.status).toBe(200);
    expect(inlineImage.headers.get("content-type")).toBe("image/png");
    expect(inlineImage.headers.get("content-disposition")).toContain("inline");
    await inlineImage.arrayBuffer();

    const unsafeInline = await worker.fetch(
      new Request(
        `http://example.test/api/mail/messages/${publicMessageId}/attachments/${unsafeInlineId}/inline?mailboxId=${personalMailboxId}`,
        { headers: { cookie } }
      )
    );

    expect(unsafeInline.status).toBe(404);
    await unsafeInline.json();

    const secondBootstrap = await worker.fetch(
      new Request("http://example.test/api/auth/mock/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Second Admin",
          email: "other@example.test",
        }),
      })
    );

    expect(secondBootstrap.status).toBe(409);
    await secondBootstrap.json();

    const { rejection } = await hooks.email({
      from: "sender@example.net",
      to: "missing@example.test",
      raw: "Subject: Unknown\r\n\r\nHello",
    });

    expect(rejection).toContain("does not exist");

    const knownRecipient = {
      from: "sender@example.net",
      to: "admin@example.test",
      raw: "From: Sender <sender@example.net>\r\nTo: admin@example.test\r\nSubject: Inbound test\r\nMessage-ID: <inbound-test@example.net>\r\n\r\nHello from email routing.",
    };

    // A known mailbox is never rejected, and the same message is stored once.
    expect((await hooks.email(knownRecipient)).rejection).toBeUndefined();
    expect((await hooks.email(knownRecipient)).rejection).toBeUndefined();

    const stored = await env.MAIL_STORAGE.list({
      prefix: `mailboxes/${personalMailboxId}/raw/`,
    });

    expect(stored.objects).toHaveLength(1);
  });
});
