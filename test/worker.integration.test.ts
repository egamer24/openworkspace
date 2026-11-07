import { env, exports } from "cloudflare:workers";
import {
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../worker";
import { hashToken } from "../worker/lib/crypto";
import { prepareOutboundDelivery } from "../worker/mail/outbound-delivery";
import {
  composerUploadMetaKey,
  discardComposerUploads,
} from "../worker/mail/uploads";

describe("mail worker", () => {
  it("bootstraps the only initial admin and protects mailbox data", async () => {
    const anonymousMail = await exports.default.fetch(
      "http://example.test/api/mail/mailboxes",
    );
    expect(anonymousMail.status).toBe(401);
    await anonymousMail.json();

    const before = await exports.default.fetch(
      "http://example.test/api/auth/state",
    );
    expect(await before.json()).toMatchObject({
      ok: true,
      needsBootstrap: true,
      authenticated: false,
    });

    const bootstrap = await exports.default.fetch(
      new Request("http://example.test/api/auth/mock/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Test Admin", email: "admin@example.test" }),
      }),
    );
    expect(bootstrap.status).toBe(200);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    await bootstrap.json();

    const mailboxes = await exports.default.fetch(
      new Request("http://example.test/api/mail/mailboxes", {
        headers: { cookie: cookie! },
      }),
    );
    const mailboxBody = (await mailboxes.json()) as {
      ok: true;
      mailboxes: Array<{
        id: string;
        address: string;
        kind: string;
        canSend: boolean;
        unreadCount: number;
      }>;
    };
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
    const personalMailboxId = mailboxBody.mailboxes[0]!.id;
    const adminState = await exports.default.fetch(
      new Request("http://example.test/api/admin/state", {
        headers: { cookie: cookie! },
      }),
    );
    expect(await adminState.json()).toMatchObject({
      ok: true,
      aiProcessingEnabled: false,
    });
    const enableGlobalAi = await exports.default.fetch(
      new Request("http://example.test/api/admin/ai", {
        method: "PUT",
        headers: {
          cookie: cookie!,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(await enableGlobalAi.json()).toMatchObject({
      ok: true,
      enabled: true,
    });
    const defaultAiSettings = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${personalMailboxId}/ai`,
        { headers: { cookie: cookie! } },
      ),
    );
    expect(await defaultAiSettings.json()).toMatchObject({
      ok: true,
      settings: {
        globalEnabled: true,
        configuration: {
          instructions: "",
          confidenceThreshold: 75,
        },
      },
    });
    const updateAiSettings = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${personalMailboxId}/ai`,
        {
          method: "PUT",
          headers: {
            cookie: cookie!,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            instructions: "Prefer Product for launch discussions.",
            confidenceThreshold: 80,
          }),
        },
      ),
    );
    expect(await updateAiSettings.json()).toMatchObject({
      ok: true,
      settings: {
        globalEnabled: true,
        configuration: {
          instructions: "Prefer Product for launch discussions.",
          confidenceThreshold: 80,
        },
      },
    });
    const disableGlobalAi = await exports.default.fetch(
      new Request("http://example.test/api/admin/ai", {
        method: "PUT",
        headers: {
          cookie: cookie!,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(await disableGlobalAi.json()).toMatchObject({
      ok: true,
      enabled: false,
    });
    const foldersResponse = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${personalMailboxId}/folders`,
        { headers: { cookie: cookie! } },
      ),
    );
    const foldersBody = await foldersResponse.json<{
      folders: Array<{ id: string; systemType: string | null }>;
    }>();
    expect(foldersBody.folders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "inbox", systemType: "inbox" }),
      expect.objectContaining({ id: "sent", systemType: "sent" }),
    ]));
    const adminRow = await env.DB.prepare(
      "SELECT id FROM users WHERE role = 'admin'",
    ).first<{ id: string }>();
    expect(adminRow?.id).toBeTruthy();

    const addDomain = await exports.default.fetch(
      new Request("http://example.test/api/admin/domains", {
        method: "POST",
        headers: { cookie: cookie!, "content-type": "application/json" },
        body: JSON.stringify({
          name: "secondary.test",
          cloudflareZoneId: null,
        }),
      }),
    );
    expect(addDomain.status).toBe(201);
    const addedDomain = await addDomain.json<{ domainId: string }>();
    const createSecondaryPersonal = await exports.default.fetch(
      new Request("http://example.test/api/admin/mailboxes", {
        method: "POST",
        headers: { cookie: cookie!, "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Test Admin Secondary",
          address: "admin@secondary.test",
          ownerUserId: adminRow!.id,
          members: [],
        }),
      }),
    );
    expect(createSecondaryPersonal.status).toBe(201);
    const secondaryPersonal = await createSecondaryPersonal.json<{
      mailboxId: string;
    }>();
    let secondaryRejection: string | undefined;
    await worker.email({
      from: "sender@example.net",
      to: "admin@secondary.test",
      raw: new Response(
        "From: Sender <sender@example.net>\r\nTo: admin@secondary.test\r\nSubject: Secondary domain\r\nMessage-ID: <secondary-domain@example.net>\r\n\r\nHello from the second domain.",
      ).body!,
      headers: new Headers(),
      rawSize: 172,
      setReject: (reason: string) => {
        secondaryRejection = reason;
      },
    } as unknown as ForwardableEmailMessage, env);
    expect(secondaryRejection).toBeUndefined();
    const secondaryRaw = await env.MAIL_STORAGE.list({
      prefix: `mailboxes/${secondaryPersonal.mailboxId}/raw/`,
    });
    expect(secondaryRaw.objects).toHaveLength(1);
    await env.DB.prepare("UPDATE users SET updated_at = 1 WHERE id = ?")
      .bind(adminRow!.id)
      .run();
    const setSecondaryPrimary = await exports.default.fetch(
      new Request(
        `http://example.test/api/admin/mailboxes/${secondaryPersonal.mailboxId}/primary`,
        { method: "POST", headers: { cookie: cookie! } },
      ),
    );
    expect(setSecondaryPrimary.status).toBe(200);
    await setSecondaryPrimary.json();
    const stateWithSecondaryPrimary = await exports.default.fetch(
      new Request("http://example.test/api/admin/state", {
        headers: { cookie: cookie! },
      }),
    );
    expect(await stateWithSecondaryPrimary.json()).toMatchObject({
      users: [{ personalEmail: "admin@secondary.test" }],
    });
    const userAfterPrimaryChange = await env.DB.prepare(
      "SELECT updated_at AS updatedAt FROM users WHERE id = ?",
    ).bind(adminRow!.id).first<{ updatedAt: number }>();
    expect(userAfterPrimaryChange!.updatedAt).toBeGreaterThan(1);
    const restorePrimary = await exports.default.fetch(
      new Request(
        `http://example.test/api/admin/mailboxes/${personalMailboxId}/primary`,
        { method: "POST", headers: { cookie: cookie! } },
      ),
    );
    expect(restorePrimary.status).toBe(200);
    await restorePrimary.json();
    const blockedDomainDelete = await exports.default.fetch(
      new Request(
        `http://example.test/api/admin/domains/${addedDomain.domainId}`,
        { method: "DELETE", headers: { cookie: cookie! } },
      ),
    );
    expect(blockedDomainDelete.status).toBe(409);
    await blockedDomainDelete.json();
    const deleteSecondary = await exports.default.fetch(
      new Request(
        `http://example.test/api/admin/mailboxes/${secondaryPersonal.mailboxId}`,
        { method: "DELETE", headers: { cookie: cookie! } },
      ),
    );
    expect(deleteSecondary.status).toBe(200);
    await deleteSecondary.json();
    const deleteDomain = await exports.default.fetch(
      new Request(
        `http://example.test/api/admin/domains/${addedDomain.domainId}`,
        { method: "DELETE", headers: { cookie: cookie! } },
      ),
    );
    expect(deleteDomain.status).toBe(200);
    await deleteDomain.json();

    const createShared = await exports.default.fetch(
      new Request("http://example.test/api/admin/mailboxes", {
        method: "POST",
        headers: {
          cookie: cookie!,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          displayName: "Support",
          address: "support@example.test",
          ownerUserId: null,
          members: [
            {
              userId: adminRow!.id,
              canSend: true,
            },
          ],
        }),
      }),
    );
    expect(createShared.status).toBe(201);
    const { mailboxId: sharedMailboxId } = (await createShared.json()) as {
      mailboxId: string;
    };

    const createInvitation = await exports.default.fetch(
      new Request("http://example.test/api/admin/invitations", {
        method: "POST",
        headers: {
          cookie: cookie!,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Invited User",
          email: "invited@example.test",
        }),
      }),
    );
    expect(createInvitation.status).toBe(201);
    const invitationBody = (await createInvitation.json()) as {
      accessLink: { userId: string };
    };

    const updateMailbox = await exports.default.fetch(
      new Request(
        `http://example.test/api/admin/mailboxes/${sharedMailboxId}`,
        {
          method: "PATCH",
          headers: {
            cookie: cookie!,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            displayName: "Customer support",
            members: [
              {
                userId: adminRow!.id,
                canSend: true,
              },
              {
                userId: invitationBody.accessLink.userId,
                canSend: false,
              },
            ],
          }),
        },
      ),
    );
    expect(updateMailbox.status).toBe(200);
    await updateMailbox.json();

    const updateUser = await exports.default.fetch(
      new Request(
        `http://example.test/api/admin/users/${invitationBody.accessLink.userId}`,
        {
          method: "PATCH",
          headers: {
            cookie: cookie!,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Invited User Updated",
          }),
        },
      ),
    );
    expect(updateUser.status).toBe(200);
    await updateUser.json();
    const renamedPersonalMailbox = await env.DB.prepare(
      "SELECT display_name AS displayName FROM mailboxes WHERE owner_user_id = ? AND is_primary = 1",
    )
      .bind(invitationBody.accessLink.userId)
      .first<{ displayName: string }>();
    expect(renamedPersonalMailbox).toEqual({
      displayName: "Invited User Updated",
    });
    const storedMembership = await env.DB.prepare(
      "SELECT can_send AS canSend FROM mailbox_members WHERE user_id = ? AND mailbox_id = ?",
    )
      .bind(invitationBody.accessLink.userId, sharedMailboxId)
      .first<{ canSend: number }>();
    expect(storedMembership).toEqual({ canSend: 0 });

    const replacementInvitation = await exports.default.fetch(
      new Request(
        `http://example.test/api/admin/users/${invitationBody.accessLink.userId}/access-link`,
        { method: "POST", headers: { cookie: cookie! } },
      ),
    );
    expect(replacementInvitation.status).toBe(201);
    const replacementInvitationBody = await replacementInvitation.json<{
      accessLink: { kind: string; url: string };
    }>();
    expect(replacementInvitationBody.accessLink.kind).toBe("invitation");
    expect(new URL(replacementInvitationBody.accessLink.url).pathname).toMatch(
      /^\/invite\//u,
    );

    const recovery = await exports.default.fetch(
      new Request(
        `http://example.test/api/admin/users/${adminRow!.id}/access-link`,
        {
          method: "POST",
          headers: { cookie: cookie! },
        },
      ),
    );
    expect(recovery.status).toBe(201);
    const recoveryBody = (await recovery.json()) as {
      accessLink: { kind: string; url: string };
    };
    expect(recoveryBody.accessLink.kind).toBe("recovery");
    const recoveryToken = new URL(recoveryBody.accessLink.url).pathname.split("/").at(-1);
    expect(recoveryToken).toBeTruthy();
    const recoveryPreview = await exports.default.fetch(
      `http://example.test/api/auth/recovery/${recoveryToken}`,
    );
    expect(recoveryPreview.status).toBe(200);
    expect(await recoveryPreview.json()).toMatchObject({
      ok: true,
      accessLink: { name: "Test Admin", email: "admin@example.test" },
    });
    const recoveryOptions = await exports.default.fetch(
      new Request(`http://example.test/api/auth/recovery/${recoveryToken}/options`, {
        method: "POST",
      }),
    );
    expect(recoveryOptions.status).toBe(200);
    await recoveryOptions.json();
    const firstRecoveryLink = await env.DB.prepare(
      "SELECT id FROM access_links WHERE token_hash = ?",
    )
      .bind(await hashToken(recoveryToken!))
      .first<{ id: string }>();
    expect(firstRecoveryLink?.id).toBeTruthy();

    const replacementRecovery = await exports.default.fetch(
      new Request(
        `http://example.test/api/admin/users/${adminRow!.id}/access-link`,
        { method: "POST", headers: { cookie: cookie! } },
      ),
    );
    expect(replacementRecovery.status).toBe(201);
    const replacementBody = await replacementRecovery.json<{
      accessLink: { url: string };
    }>();
    const replacementToken = new URL(replacementBody.accessLink.url).pathname.split("/").at(-1);
    expect(replacementToken).toBeTruthy();
    expect((await exports.default.fetch(
      `http://example.test/api/auth/recovery/${recoveryToken}`,
    )).status).toBe(404);
    const abandonedChallenges = await env.DB.prepare(
      "SELECT count(*) AS count FROM auth_challenges WHERE access_link_id = ?",
    )
      .bind(firstRecoveryLink!.id)
      .first<{ count: number }>();
    expect(abandonedChallenges?.count).toBe(0);
    const activeRecoveryLinks = await env.DB.prepare(
      "SELECT count(*) AS count FROM access_links WHERE user_id = ? AND kind = 'recovery' AND consumed_at IS NULL",
    )
      .bind(adminRow!.id)
      .first<{ count: number }>();
    expect(activeRecoveryLinks?.count).toBe(1);

    const inboundDeliveryId = "inbound-alarm-test";
    const inboundObjectKey = "test/inbound-alarm.eml";
    const inboundReceivedAt = Date.now();
    const inboundRaw = "From: Alarm Sender <alarm@example.net>\r\nTo: admin@example.test\r\nSubject: Alarm inbound\r\nDate: Thu, 1 Jan 2099 00:00:00 +0000\r\nMessage-ID: <alarm-inbound@example.net>\r\n\r\nPersisted by the mailbox alarm.";
    await env.MAIL_STORAGE.put(
      inboundObjectKey,
      inboundRaw,
    );
    const mailbox = env.MAILBOX.getByName(personalMailboxId);
    await expect(mailbox.enqueueInbound({
      id: inboundDeliveryId,
      mailboxId: personalMailboxId,
      rawObjectKey: inboundObjectKey,
      envelopeFrom: "alarm@example.net",
      envelopeTo: "admin@example.test",
      receivedAt: inboundReceivedAt,
    })).resolves.toEqual({
      messageId: `msg_${inboundDeliveryId}`,
      queued: true,
    });
    await runDurableObjectAlarm(mailbox);
    const inboundMessage = await mailbox.getEmailByMessageId(
      "<alarm-inbound@example.net>",
    );
    expect(inboundMessage?.subject).toBe("Alarm inbound");
    expect(inboundMessage?.bodyText?.trim()).toBe(
      "Persisted by the mailbox alarm.",
    );
    expect(inboundMessage?.transportState).toBe("received");
    expect(inboundMessage!.timelineAt.getTime()).toBe(inboundReceivedAt);
    const inboundConversation = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/conversations/${inboundMessage!.conversationId}?mailboxId=${personalMailboxId}`,
        { headers: { cookie: cookie! } },
      ),
    );
    expect(inboundConversation.status).toBe(200);
    expect(await inboundConversation.json()).toMatchObject({
      messages: [{ id: inboundMessage!.id, hasOriginal: true }],
    });
    const original = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/messages/${inboundMessage!.id}/original?mailboxId=${personalMailboxId}`,
        { headers: { cookie: cookie! } },
      ),
    );
    expect(original.status).toBe(200);
    expect(original.headers.get("content-type")).toContain("text/plain");
    expect(original.headers.get("content-disposition")).toContain("inline");
    expect(await original.text()).toBe(inboundRaw);

    const suffixLength = 12;
    const originalSuffix = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/messages/${inboundMessage!.id}/original?mailboxId=${personalMailboxId}`,
        {
          headers: {
            cookie: cookie!,
            range: `bytes=-${suffixLength}`,
          },
        },
      ),
    );
    expect(originalSuffix.status).toBe(206);
    expect(originalSuffix.headers.get("content-length")).toBe(
      String(suffixLength),
    );
    expect(originalSuffix.headers.get("content-range")).toBe(
      `bytes ${inboundRaw.length - suffixLength}-${inboundRaw.length - 1}/${inboundRaw.length}`,
    );
    expect(await originalSuffix.text()).toBe(inboundRaw.slice(-suffixLength));

    const openRangeOffset = 10;
    const originalTail = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/messages/${inboundMessage!.id}/original?mailboxId=${personalMailboxId}`,
        {
          headers: {
            cookie: cookie!,
            range: `bytes=${openRangeOffset}-`,
          },
        },
      ),
    );
    expect(originalTail.status).toBe(206);
    expect(originalTail.headers.get("content-length")).toBe(
      String(inboundRaw.length - openRangeOffset),
    );
    expect(originalTail.headers.get("content-range")).toBe(
      `bytes ${openRangeOffset}-${inboundRaw.length - 1}/${inboundRaw.length}`,
    );
    expect(await originalTail.text()).toBe(inboundRaw.slice(openRangeOffset));
    const authentication = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/messages/${inboundMessage!.id}/authentication?mailboxId=${personalMailboxId}`,
        { headers: { cookie: cookie! } },
      ),
    );
    expect(authentication.status).toBe(200);
    expect(await authentication.json()).toMatchObject({
      ok: true,
      state: "unavailable",
      reason: "not_configured",
      original: {
        subject: "Alarm inbound",
        from: "alarm@example.net",
        to: ["admin@example.test"],
        messageId: "<alarm-inbound@example.net>",
      },
    });
    await expect(mailbox.enqueueInbound({
      id: inboundDeliveryId,
      mailboxId: personalMailboxId,
      rawObjectKey: inboundObjectKey,
      envelopeFrom: "alarm@example.net",
      envelopeTo: "admin@example.test",
      receivedAt: inboundReceivedAt,
    })).resolves.toEqual({
      messageId: inboundMessage!.id,
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
      ].join("\r\n"),
    );
    await mailbox.enqueueInbound({
      id: htmlDeliveryId,
      mailboxId: personalMailboxId,
      rawObjectKey: htmlObjectKey,
      envelopeFrom: "auth@example.net",
      envelopeTo: "admin@example.test",
      receivedAt: inboundReceivedAt + 1,
    });
    await runDurableObjectAlarm(mailbox);
    const htmlMessage = await mailbox.getEmailByMessageId(
      "<html-only@example.net>",
    );
    expect(htmlMessage?.bodyText).toContain("482901");
    expect(htmlMessage?.bodyHtmlR2Key).toBeTruthy();
    const htmlConversation = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/conversations/${htmlMessage!.conversationId}?mailboxId=${personalMailboxId}`,
        { headers: { cookie: cookie! } },
      ),
    );
    expect(htmlConversation.status).toBe(200);
    expect(await htmlConversation.json()).toMatchObject({
      messages: [{
        id: htmlMessage!.id,
        bodyHtml: expect.stringContaining("<strong>482901</strong>"),
      }],
    });

    const blockedRemote = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/remote?mailboxId=${personalMailboxId}&url=${encodeURIComponent("http://127.0.0.1/secret.png")}`,
        { headers: { cookie: cookie! } },
      ),
    );
    expect(blockedRemote.status).toBe(400);
    await blockedRemote.json();

    const anonymousRemote = await exports.default.fetch(
      `http://example.test/api/mail/remote?mailboxId=${personalMailboxId}&url=${encodeURIComponent("https://cdn.example/a.png")}`,
    );
    expect(anonymousRemote.status).toBe(401);
    await anonymousRemote.json();

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
    await runDurableObjectAlarm(mailbox);
    const pendingRetry = await runInDurableObject(
      mailbox,
      (_instance, state) => state.storage.sql.exec<{
        attempts: number;
      }>(
        "select attempts from pending_inbound where id = ?",
        retriedDeliveryId,
      ).one(),
    );
    expect(pendingRetry.attempts).toBe(1);
    await expect(mailbox.getEmail(`msg_${retriedDeliveryId}`)).resolves.toBeNull();
    await env.MAIL_STORAGE.put(
      retriedObjectKey,
      "From: Retry Sender <retry@example.net>\r\nTo: admin@example.test\r\nSubject: Retried inbound\r\nMessage-ID: <retried-inbound@example.net>\r\n\r\nAvailable after the first alarm.",
    );
    await runInDurableObject(
      mailbox,
      (_instance, state) => {
        state.storage.sql.exec(
          "update pending_inbound set next_attempt_at = 0 where id = ?",
          retriedDeliveryId,
        );
        return true;
      },
    );
    await runDurableObjectAlarm(mailbox);
    await expect(mailbox.getEmail(`msg_${retriedDeliveryId}`)).resolves.toMatchObject({
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
      receivedAt: Date.now() - 24 * 60 * 60 * 1_000 - 1,
    });
    await runDurableObjectAlarm(mailbox);
    await expect(mailbox.getEmail(`msg_${unavailableDeliveryId}`)).resolves.toMatchObject({
      subject: "(unreadable message)",
      bodyText: expect.stringContaining("remained unavailable for 24 hours"),
      rawMimeR2Key: null,
      transportState: "received",
    });

    // A message that aborted earlier alarms (CPU or memory) left only its
    // leased attempts behind: it backs off and is never parsed again after 24h.
    const poisonDeliveryId = "inbound-poison";
    const poisonKey = "test/inbound-poison.eml";
    await env.MAIL_STORAGE.put(poisonKey, "From: p@example.net\r\nTo: admin@example.test\r\nSubject: Poison\r\n\r\nx");
    await mailbox.enqueueInbound({
      id: poisonDeliveryId,
      mailboxId: personalMailboxId,
      rawObjectKey: poisonKey,
      envelopeFrom: "p@example.net",
      envelopeTo: "admin@example.test",
      receivedAt: Date.now() - 24 * 60 * 60 * 1_000 - 1,
    });
    await runInDurableObject(mailbox, (_instance, state) => {
      state.storage.sql.exec("update pending_inbound set attempts = 7 where id = ?", poisonDeliveryId);
    });
    await runDurableObjectAlarm(mailbox);
    await expect(mailbox.getEmail(`msg_${poisonDeliveryId}`)).resolves.toMatchObject({
      subject: "(unreadable message)",
      rawMimeR2Key: poisonKey,
    });

    const searchResponse = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/conversations?mailboxId=${personalMailboxId}&folder=inbox&search=Persisted`,
        { headers: { cookie: cookie! } },
      ),
    );
    expect(searchResponse.status).toBe(200);
    expect(await searchResponse.json()).toMatchObject({
      conversations: [{ conversationId: inboundMessage!.conversationId }],
    });

    const conversationResponse = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/conversations/${inboundMessage!.conversationId}?mailboxId=${personalMailboxId}`,
        { headers: { cookie: cookie! } },
      ),
    );
    expect(conversationResponse.status).toBe(200);
    expect(await conversationResponse.json()).toMatchObject({
      ok: true,
      messages: [{
        id: inboundMessage!.id,
        quotedText: null,
        replyPlan: {
          defaultMode: "reply",
          isGroup: false,
          actions: [{
            mode: "reply",
            to: ["alarm@example.net"],
            cc: [],
          }],
        },
      }],
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
    const replyResponse = await exports.default.fetch(
      new Request(`http://example.test/api/mail/messages/${inboundMessage!.id}/replies`, {
        method: "POST",
        headers: { cookie: cookie!, "content-type": "application/json" },
        body: JSON.stringify(replyPayload),
      }),
    );
    expect(replyResponse.status).toBe(201);
    const replyBody = await replyResponse.json<{
      messageId: string;
      conversationId: string;
      transportError: string | null;
    }>();
    expect(replyBody.transportError).toBeNull();
    const storedReply = await mailbox.getEmail(replyBody.messageId);
    expect(storedReply).toMatchObject({
      conversationId: inboundMessage!.conversationId,
      inReplyToJson: ["<alarm-inbound@example.net>"],
      referencesJson: ["<alarm-inbound@example.net>"],
    });
    const duplicateReply = await exports.default.fetch(
      new Request(`http://example.test/api/mail/messages/${inboundMessage!.id}/replies`, {
        method: "POST",
        headers: { cookie: cookie!, "content-type": "application/json" },
        body: JSON.stringify(replyPayload),
      }),
    );
    expect(duplicateReply.status).toBe(200);
    expect(await duplicateReply.json()).toMatchObject({
      messageId: replyBody.messageId,
      conversationId: replyBody.conversationId,
    });
    expect(
      (await mailbox.getConversation(replyBody.conversationId))
        .filter((message) => message.id === replyBody.messageId),
    ).toHaveLength(1);

    const outboundMessageId = "msg_alarm_outbound";
    const timestamp = new Date();
    const outboundAttachmentKey = `mailboxes/${personalMailboxId}/messages/${outboundMessageId}/attachments/att_alarm`;
    await env.MAIL_STORAGE.put(
      outboundAttachmentKey,
      new TextEncoder().encode("alarm attachment"),
      { httpMetadata: { contentType: "text/plain" } },
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
      attachmentsJson: [{
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
      }],
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
    const unconfirmedMessage = await mailbox.getEmail(unconfirmedMessageId);
    expect(unconfirmedMessage).toBeTruthy();
    const idempotentReplay = await mailbox.submitOutgoing(unconfirmedMessage!);
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
      attachmentsJson: [{
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
      }],
      timelineAt: new Date(),
      transportState: "unconfirmed",
    });
    expect(failedSubmission.email).toMatchObject({
      transportState: "failed",
      transportError: "Attachment missing.txt is missing",
    });
    expect((await mailbox.resendOutgoing(failedMessageId))).toMatchObject({
      transportState: "failed",
    });

    async function sentPage(cursor?: string) {
      const url = new URL("http://example.test/api/mail/conversations");
      url.searchParams.set("mailboxId", personalMailboxId);
      url.searchParams.set("folder", "sent");
      url.searchParams.set("limit", "1");
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await exports.default.fetch(
        new Request(url, { headers: { cookie: cookie! } }),
      );
      expect(response.status).toBe(200);
      return response.json<{
        conversations: Array<{ conversationId: string }>;
        nextCursor: string | null;
      }>();
    }

    const sentFirst = await sentPage();
    expect(sentFirst.conversations).toHaveLength(1);
    expect(sentFirst.nextCursor).toBeTruthy();
    const sentSecond = await sentPage(sentFirst.nextCursor!);
    expect(sentSecond.conversations).toHaveLength(1);
    expect(sentSecond.nextCursor).toBeNull();
    expect(new Set([
      sentFirst.conversations[0]!.conversationId,
      sentSecond.conversations[0]!.conversationId,
    ]).size).toBe(2);

    const forwardResponse = await exports.default.fetch(
      new Request(`http://example.test/api/mail/messages/${outboundMessageId}/forward`, {
        method: "POST",
        headers: { cookie: cookie!, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          mailboxId: personalMailboxId,
          to: ["forward-recipient@example.net"],
          cc: [],
          bcc: [],
          bodyText: "Please review this message.",
        }),
      }),
    );
    expect(forwardResponse.status).toBe(201);
    const forwardBody = await forwardResponse.json<{
      messageId: string;
      conversationId: string;
      detached: boolean;
    }>();
    const forwardedMessage = await mailbox.getEmail(forwardBody.messageId);
    expect(forwardedMessage).toMatchObject({
      bodyText: expect.stringContaining("Forwarded message"),
      attachmentsJson: [expect.objectContaining({
        id: "fwd_att_1",
        filename: "alarm.txt",
      })],
    });
    const forwardedAttachment = forwardedMessage!.attachmentsJson[0]!;
    expect(forwardedAttachment.r2Key).not.toBe(outboundAttachmentKey);
    expect(await env.MAIL_STORAGE.get(outboundAttachmentKey)).not.toBeNull();
    expect(await env.MAIL_STORAGE.get(forwardedAttachment.r2Key).then(
      (object) => object?.text(),
    )).toBe("alarm attachment");
    expect(forwardedMessage?.bodyText).toContain("Outbound alarm body");

    const contextResponse = await exports.default.fetch(
      new Request(`http://example.test/api/mail/messages/${inboundMessage!.id}/replies`, {
        method: "POST",
        headers: { cookie: cookie!, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          mailboxId: personalMailboxId,
          mode: "reply",
          cc: ["new-participant@example.net"],
          bcc: [],
          bodyText: "Adding someone who needs the context.",
          bodyHtml: "<p><strong>Adding someone who needs the context.</strong></p>",
        }),
      }),
    );
    expect(contextResponse.status).toBe(201);
    const contextBody = await contextResponse.json<{
      messageId: string;
      conversationId: string;
      detached: boolean;
    }>();
    expect(contextBody).toMatchObject({
      conversationId: inboundMessage!.conversationId,
      detached: false,
    });
    const contextMessage = await mailbox.getEmail(contextBody.messageId);
    expect(contextMessage).toMatchObject({
      bodyText: "Adding someone who needs the context.",
      quotedText: expect.stringContaining("Persisted by the mailbox alarm."),
    });
    const storedContextHtml = contextMessage?.bodyHtmlR2Key
      ? await env.MAIL_STORAGE.get(contextMessage.bodyHtmlR2Key).then(
          (object) => object?.text(),
        )
      : null;
    expect(storedContextHtml).toBe(
      "<p><strong>Adding someone who needs the context.</strong></p>",
    );
    const contextDelivery = await prepareOutboundDelivery(env, contextMessage!);
    expect(contextDelivery.html).toContain(
      "<strong>Adding someone who needs the context.</strong>",
    );
    expect(contextDelivery.html).toContain("Persisted by the mailbox alarm.");

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
    const privateFromGroupResponse = await exports.default.fetch(
      new Request(`http://example.test/api/mail/messages/${groupParentId}/replies`, {
        method: "POST",
        headers: { cookie: cookie!, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          mailboxId: personalMailboxId,
          mode: "reply",
          cc: [],
          bcc: [],
          bodyText: "This is private.",
        }),
      }),
    );
    expect(privateFromGroupResponse.status).toBe(201);
    const privateFromGroup = await privateFromGroupResponse.json<{
      messageId: string;
      conversationId: string;
      detached: boolean;
    }>();
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
    const listReplyResponse = await exports.default.fetch(
      new Request(`http://example.test/api/mail/messages/${listParentId}/replies`, {
        method: "POST",
        headers: { cookie: cookie!, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          mailboxId: personalMailboxId,
          mode: "reply_list",
          cc: [],
          bcc: [],
          bodyText: "Replying to the list.",
        }),
      }),
    );
    expect(listReplyResponse.status).toBe(201);
    const listReply = await listReplyResponse.json<{
      messageId: string;
      detached: boolean;
    }>();
    expect(listReply.detached).toBe(false);
    expect(await mailbox.getEmail(listReply.messageId)).toMatchObject({
      listId: "workers.example.net",
      listPostAddress: "workers@example.net",
    });
    const privateListReplyResponse = await exports.default.fetch(
      new Request(`http://example.test/api/mail/messages/${listParentId}/replies`, {
        method: "POST",
        headers: { cookie: cookie!, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          mailboxId: personalMailboxId,
          mode: "reply",
          cc: [],
          bcc: [],
          bodyText: "Replying privately to the author.",
        }),
      }),
    );
    expect(privateListReplyResponse.status).toBe(201);
    const privateListReply = await privateListReplyResponse.json<{
      messageId: string;
      detached: boolean;
    }>();
    expect(privateListReply.detached).toBe(true);
    expect(await mailbox.getEmail(privateListReply.messageId)).toMatchObject({
      listId: null,
      listPostAddress: null,
    });

    const archiveConversation = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/conversations/bulk?mailboxId=${personalMailboxId}`,
        {
          method: "PATCH",
          headers: { cookie: cookie!, "content-type": "application/json" },
          body: JSON.stringify({
            type: "update",
            conversationIds: [inboundMessage!.conversationId],
            sourceFolderId: "inbox",
            update: { mailboxState: "archive" },
          }),
        },
      ),
    );
    expect(archiveConversation.status).toBe(200);
    await archiveConversation.json();
    const archivedConversation = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/conversations/${inboundMessage!.conversationId}?mailboxId=${personalMailboxId}`,
        { headers: { cookie: cookie! } },
      ),
    );
    expect(await archivedConversation.json()).toMatchObject({ mailboxState: "archive" });
    const restoreConversation = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/conversations/bulk?mailboxId=${personalMailboxId}`,
        {
          method: "PATCH",
          headers: { cookie: cookie!, "content-type": "application/json" },
          body: JSON.stringify({
            type: "update",
            conversationIds: [inboundMessage!.conversationId],
            sourceFolderId: "archive",
            update: { mailboxState: "active" },
          }),
        },
      ),
    );
    expect(restoreConversation.status).toBe(200);
    await restoreConversation.json();

    const invalidCursor = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/conversations?mailboxId=${personalMailboxId}&folder=sent&cursor=not-a-cursor`,
        { headers: { cookie: cookie! } },
      ),
    );
    expect(invalidCursor.status).toBe(400);
    await invalidCursor.json();

    const directUploadUnavailable = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/uploads?mailboxId=${personalMailboxId}&directOnly=true`,
        {
          method: "POST",
          headers: { cookie: cookie!, "content-type": "application/json" },
          body: JSON.stringify({
            filename: "direct.txt",
            contentType: "text/plain",
            size: 2,
          }),
        },
      ),
    );
    expect(directUploadUnavailable.status).toBe(503);
    expect(await directUploadUnavailable.json()).toMatchObject({
      error: { code: "UNAVAILABLE" },
    });

    const concurrentRequestId = crypto.randomUUID();
    async function uploadAttachment(filename: string, body: string) {
      const intentResponse = await exports.default.fetch(
        new Request(
          `http://example.test/api/mail/uploads?mailboxId=${personalMailboxId}`,
          {
            method: "POST",
            headers: {
              cookie: cookie!,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              filename,
              contentType: "text/plain",
              size: new TextEncoder().encode(body).byteLength,
            }),
          },
        ),
      );
      expect(intentResponse.status).toBe(201);
      const intent = await intentResponse.json() as {
        upload: {
          id: string;
          uploadUrl: string;
          headers: Record<string, string>;
        };
      };
      const put = await exports.default.fetch(
        new Request(intent.upload.uploadUrl, {
          method: "PUT",
          headers: {
            cookie: cookie!,
            ...intent.upload.headers,
          },
          body,
        }),
      );
      expect(put.status).toBe(200);
      await put.json();
      const complete = await exports.default.fetch(
        new Request(
          `http://example.test/api/mail/uploads/${intent.upload.id}/complete?mailboxId=${personalMailboxId}`,
          {
            method: "POST",
            headers: { cookie: cookie! },
          },
        ),
      );
      expect(complete.status).toBe(200);
      await complete.json();
      return intent.upload.id;
    }
    const uploadA = await uploadAttachment(
      "request-a.txt",
      "attachment from request A",
    );
    const uploadB = await uploadAttachment(
      "request-b.txt",
      "attachment from request B",
    );
    const attachmentPreflight = await exports.default.fetch(
      new Request("http://example.test/api/mail/attachment-preflight", {
        method: "POST",
        headers: {
          cookie: cookie!,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: "compose",
          mailboxId: personalMailboxId,
          subject: "Attachment preflight",
          bodyText: "Small attachment",
          attachments: [{ uploadId: uploadA }],
        }),
      }),
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
    const concurrentResponses = await Promise.all(concurrentPayloads.map((payload) =>
      exports.default.fetch(
        new Request("http://example.test/api/mail/messages", {
          method: "POST",
          headers: { cookie: cookie!, "content-type": "application/json" },
          body: JSON.stringify(payload),
        }),
      )
    ));
    const concurrentResults = await Promise.all(concurrentResponses.map(async (response) => ({
      status: response.status,
      body: await response.json<{ messageId?: string }>(),
    })));
    expect(concurrentResults.map((result) => result.status).sort()).toEqual([201, 409]);
    const winnerIndex = concurrentResults.findIndex((result) => result.status === 201);
    const winner = concurrentResults[winnerIndex]!;
    const winnerPayload = concurrentPayloads[winnerIndex]!;
    const concurrentEmail = await mailbox.getEmail(winner.body.messageId!);
    expect(concurrentEmail).toMatchObject({
      subject: winnerPayload.subject,
      bodyText: winnerPayload.bodyText,
      toJson: [{ address: "CaseSensitive@example.net", name: null }],
    });
    const concurrentAttachment = concurrentEmail!.attachmentsJson[0]!;
    const concurrentObject = await env.MAIL_STORAGE.get(concurrentAttachment.r2Key);
    expect(await concurrentObject?.text()).toBe(
      `attachment from request ${winnerIndex === 0 ? "A" : "B"}`,
    );
    const winnerUpload = winnerIndex === 0 ? uploadA : uploadB;
    const losingUpload = winnerIndex === 0 ? uploadB : uploadA;
    await vi.waitFor(async () => {
      expect(
        await env.MAIL_STORAGE.head(
          composerUploadMetaKey(personalMailboxId, adminRow!.id, winnerUpload),
        ),
      ).toBeNull();
    }, { timeout: 2_000 });
    expect(
      await env.MAIL_STORAGE.head(
        composerUploadMetaKey(personalMailboxId, adminRow!.id, losingUpload),
      ),
    ).not.toBeNull();
    await discardComposerUploads({
      env,
      mailboxId: personalMailboxId,
      userId: adminRow!.id,
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
    await env.MAIL_STORAGE.put(inlineImageKey, new Uint8Array([137, 80, 78, 71]));
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
      attachmentsJson: [{
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
      }, {
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
      }, {
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
      }],
    });
    const publicDownload = await exports.default.fetch(
      `http://example.test/api/downloads/mail/${publicToken}`,
    );
    expect(publicDownload.status).toBe(200);
    expect(await publicDownload.text()).toBe("public download body");
    const authenticatedDownload = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/messages/${publicMessageId}/attachments/${unsafeInlineId}?mailboxId=${personalMailboxId}`,
        { headers: { cookie: cookie! } },
      ),
    );
    expect(authenticatedDownload.status).toBe(200);
    expect(authenticatedDownload.headers.get("content-disposition")).toContain(
      "attachment",
    );
    expect(await authenticatedDownload.text()).toContain("<script>");
    const inlineImage = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/messages/${publicMessageId}/attachments/${inlineImageId}/inline?mailboxId=${personalMailboxId}`,
        { headers: { cookie: cookie! } },
      ),
    );
    expect(inlineImage.status).toBe(200);
    expect(inlineImage.headers.get("content-type")).toBe("image/png");
    expect(inlineImage.headers.get("content-disposition")).toContain("inline");
    await inlineImage.arrayBuffer();
    const unsafeInline = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/messages/${publicMessageId}/attachments/${unsafeInlineId}/inline?mailboxId=${personalMailboxId}`,
        { headers: { cookie: cookie! } },
      ),
    );
    expect(unsafeInline.status).toBe(404);
    await unsafeInline.json();

    const secondBootstrap = await exports.default.fetch(
      new Request("http://example.test/api/auth/mock/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Second Admin", email: "other@example.test" }),
      }),
    );
    expect(secondBootstrap.status).toBe(409);
    await secondBootstrap.json();

    let rejection: string | undefined;
    const unknownRecipient = {
      from: "sender@example.net",
      to: "missing@example.test",
      raw: new Response("Subject: Unknown\r\n\r\nHello").body!,
      headers: new Headers(),
      rawSize: 27,
      setReject: (reason: string) => {
        rejection = reason;
      },
    } as unknown as ForwardableEmailMessage;
    await worker.email(unknownRecipient, env);
    expect(rejection).toContain("does not exist");

    const knownRecipient = () => ({
      from: "sender@example.net",
      to: "admin@example.test",
      raw: new Response(
        "From: Sender <sender@example.net>\r\nTo: admin@example.test\r\nSubject: Inbound test\r\nMessage-ID: <inbound-test@example.net>\r\n\r\nHello from email routing.",
      ).body!,
      headers: new Headers(),
      rawSize: 155,
      setReject: () => {
        throw new Error("Known mailbox must not be rejected");
      },
    }) as unknown as ForwardableEmailMessage;
    await worker.email(knownRecipient(), env);
    await worker.email(knownRecipient(), env);
    const stored = await env.MAIL_STORAGE.list({
      prefix: `mailboxes/${personalMailboxId}/raw/`,
    });
    expect(stored.objects).toHaveLength(1);
  });
});
