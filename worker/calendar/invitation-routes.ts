import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { getMailboxAccess } from "../mail/access";
import { mailboxStub } from "../mailbox";
import { calendarStub } from ".";
import { parseIcs } from "./ics";
import { sendItip } from "./itip";
import { requireCalendarModule } from "./module";
import { invitationResponseSchema } from "./schemas";

const responseWords = {
  ACCEPTED: ["Accepted", "accepted"],
  TENTATIVE: ["Tentatively accepted", "tentatively accepted"],
  DECLINED: ["Declined", "declined"],
} as const;

/** Invite cards on received messages: `/mail/mailboxes/:id/messages/:emailId/invitation`. */
export const invitationRoutes = new Hono<AppEnv>()
  .get("/messages/:emailId/invitation", requireCalendarModule, requireAuth, async (c) => {
    const user = c.get("user");
    const access = await getMailboxAccess(createDb(c.env.DB), user.id, c.req.param("id")!);
    if (!access) return apiError(c, 404, "NOT_FOUND", "Mailbox not found");
    const email = await mailboxStub(c.env, access.id).getEmail(c.req.param("emailId"));
    const invitation = email?.invitationJson;
    if (!invitation) return apiError(c, 404, "NOT_FOUND", "Invitation not found");
    const calendar = calendarStub(c.env, user.id);
    const [conflicts, response] = await Promise.all([
      calendar.freeBusy(invitation.startsAt, Math.max(invitation.endsAt, invitation.startsAt + 1), undefined, invitation.uid),
      calendar.invitationResponse(invitation.uid, access.address),
    ]);
    return c.json({ ok: true as const, invitation, conflicts, response, canRespond: access.canSend });
  })
  .post(
    "/messages/:emailId/invitation/respond",
    requireCalendarModule,
    requireAuth,
    zValidator("json", invitationResponseSchema),
    async (c) => {
      const user = c.get("user");
      const { response } = c.req.valid("json");
      const access = await getMailboxAccess(createDb(c.env.DB), user.id, c.req.param("id")!);
      if (!access?.canSend) return apiError(c, 403, "FORBIDDEN", "You cannot send from this mailbox");
      const email = await mailboxStub(c.env, access.id).getEmail(c.req.param("emailId"));
      const invitation = email?.invitationJson;
      const file = email?.attachmentsJson.find((item) => item.id === invitation?.attachmentId);
      if (!email || invitation?.method !== "REQUEST" || !file) {
        return apiError(c, 404, "NOT_FOUND", "Invitation not found");
      }
      const object = await c.env.MAIL_STORAGE.get(file.r2Key);
      if (!object) return apiError(c, 404, "NOT_FOUND", "Invitation not found");
      const parsed = parseIcs(await object.text()).events.filter((event) => event.uid === invitation.uid);
      const name = user.name || access.displayName || null;
      const answered = await calendarStub(c.env, user.id).respondToInvitation({
        parsed,
        address: access.address,
        name,
        partstat: response,
      });
      if (!answered.ok) return apiError(c, answered.status, "BAD_REQUEST", answered.message);

      const event = parsed.find((item) => item.recurrenceId === null) ?? parsed[0]!;
      if (event.organizer) {
        const [subject, verb] = responseWords[response];
        await sendItip(c.env, {
          mailboxId: access.id,
          from: { address: access.address, name },
          to: [event.organizer.address],
          method: "REPLY",
          // A REPLY names only the attendee who answers (RFC 5546 §3.2.3).
          events: parsed.map((item) => ({
            ...item,
            attendees: [{
              address: access.address,
              name,
              role: "REQ-PARTICIPANT",
              partstat: response,
              rsvp: false,
            }],
          })),
          subject: `${subject}: ${event.title}`,
          intro: `${name ?? access.address} has ${verb} this invitation.`,
          related: email,
          defer: (task) => c.executionCtx.waitUntil(task),
        });
      }
      return c.json({ ok: true as const, response, eventId: answered.value.eventId });
    },
  );
