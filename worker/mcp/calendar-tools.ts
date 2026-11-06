import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { calendarEditScopes } from "../../shared/calendar";
import {
  checkTimes,
  createEventSchema,
  updateEventFieldsSchema,
} from "../calendar/schemas";
import { AccountApiClient, apiPath } from "./account-client";
import { runTool } from "./results";
import { entityIdSchema } from "./schemas";

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const write = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const rangeSchema = z.object({
  from: z.iso.datetime({ offset: true }).describe("Range start, ISO 8601 with offset."),
  to: z.iso.datetime({ offset: true }).describe("Range end (exclusive), at most 400 days after from."),
});

const occurrenceTarget = {
  eventId: entityIdSchema.describe("eventId of an occurrence from list_calendar_events."),
  scope: z.enum(calendarEditScopes).optional().describe(
    "For recurring events: this occurrence, this and following, or all (default).",
  ),
  occurrenceStart: z.iso.datetime({ offset: true }).optional().describe(
    "occurrenceStart of the occurrence; required for scope this or following.",
  ),
};

export function registerCalendarTools(server: McpServer, api: AccountApiClient) {
  server.registerTool(
    "list_calendars",
    {
      title: "List calendars",
      description: "List the current account's calendars with their ids, colors and visibility.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    () => runTool(() => api.json("/calendar/calendars")),
  );

  server.registerTool(
    "list_calendar_events",
    {
      title: "List calendar events",
      description: "List event occurrences in a time range, with recurring events expanded. Times are epoch milliseconds (UTC).",
      inputSchema: rangeSchema.extend({ calendarId: entityIdSchema.optional() }),
      annotations: readOnly,
    },
    (input) => runTool(() => api.json(apiPath("/calendar/events", input))),
  );

  server.registerTool(
    "create_calendar_event",
    {
      title: "Create calendar event",
      description: "Create an event. startsAt/endsAt accept ISO 8601 or epoch ms; all-day events use UTC midnights with an exclusive end. rrule is an RFC 5545 RRULE without the prefix, e.g. FREQ=WEEKLY;BYDAY=MO,WE.",
      inputSchema: createEventSchema,
      annotations: write,
    },
    (input) => runTool(() => api.json("/calendar/events", { method: "POST", json: input })),
  );

  server.registerTool(
    "update_calendar_event",
    {
      title: "Update calendar event",
      description: "Update an event or, for a recurring event, one occurrence, this and following, or the whole series.",
      inputSchema: updateEventFieldsSchema
        .extend({ eventId: occurrenceTarget.eventId })
        .superRefine(checkTimes),
      annotations: write,
    },
    ({ eventId, ...input }) => runTool(() => api.json(
      `/calendar/events/${encodeURIComponent(eventId)}`,
      { method: "PATCH", json: input },
    )),
  );

  server.registerTool(
    "delete_calendar_event",
    {
      title: "Delete calendar event",
      description: "Delete an event, or for a recurring event one occurrence, this and following, or the whole series.",
      inputSchema: z.object(occurrenceTarget),
      annotations: { ...write, destructiveHint: true },
    },
    ({ eventId, scope, occurrenceStart }) => runTool(() => api.json(apiPath(
      `/calendar/events/${encodeURIComponent(eventId)}`,
      { scope, occurrenceStart },
    ), { method: "DELETE" })),
  );

  server.registerTool(
    "get_free_busy",
    {
      title: "Get free/busy",
      description: "Merged busy intervals of the current account in a time range (free and cancelled events are ignored).",
      inputSchema: rangeSchema,
      annotations: readOnly,
    },
    (input) => runTool(() => api.json(apiPath("/calendar/freebusy", input))),
  );

  server.registerTool(
    "list_booking_types",
    {
      title: "List booking types",
      description: "List the current account's public booking page types (slug, duration, weekly hours, enabled) and the booking page URL.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    () => runTool(() => api.json("/calendar/booking")),
  );

  server.registerTool(
    "list_upcoming_bookings",
    {
      title: "List upcoming bookings",
      description: "List confirmed bookings made through the booking pages that have not ended yet, with guest names and emails. Times are epoch milliseconds (UTC).",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    () => runTool(() => api.json("/calendar/booking/bookings")),
  );

  server.registerTool(
    "cancel_booking",
    {
      title: "Cancel booking",
      description: "Cancel a booking: removes its calendar event and emails the guest from the booking type's sending mailbox.",
      inputSchema: z.object({
        bookingId: entityIdSchema.describe("id of a booking from list_upcoming_bookings."),
      }),
      annotations: { ...write, destructiveHint: true },
    },
    ({ bookingId }) => runTool(() => api.json(
      `/calendar/booking/bookings/${encodeURIComponent(bookingId)}/cancel`,
      { method: "POST" },
    )),
  );
}
