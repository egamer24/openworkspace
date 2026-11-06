import { z } from "zod";
import {
  BOOKING_SLUG_PATTERN,
  isValidBookingHandle,
  MAX_BOOKING_SLOT_RANGE_DAYS,
} from "../../shared/booking";
import { emailSchema } from "../auth/schemas";
import {
  weekdayCodes,
  attendeeRoles,
  calendarEditScopes,
  invitationResponses,
  MAX_ATTENDEES,
  calendarEventStatuses,
  calendarTransparencies,
  formatRecurrenceRule,
  isValidTimeZone,
  MAX_EVENT_RANGE_DAYS,
  MAX_REMINDER_MINUTES,
  MAX_REMINDERS_PER_EVENT,
  parseRecurrenceRule,
} from "../../shared/calendar";

const DAY_MS = 86_400_000;

/**
 * Epoch milliseconds or an ISO 8601 date-time with offset. Stored instants
 * are whole seconds so recurrence ids compare exactly.
 */
export const instantSchema = z.union([
  z.number().int().min(0).max(8_640_000_000_000_000),
  z.iso.datetime({ offset: true }),
]).transform((value) => {
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Math.floor(ms / 1_000) * 1_000;
});

const queryInstantSchema = z.union([
  z.string().regex(/^\d+$/u).transform(Number),
  z.iso.datetime({ offset: true }),
]).pipe(instantSchema);

export const rangeQuerySchema = z.object({
  from: queryInstantSchema,
  to: queryInstantSchema,
  calendarId: z.string().min(1).max(100).optional(),
}).refine(
  (value) => value.to > value.from && value.to - value.from <= MAX_EVENT_RANGE_DAYS * DAY_MS,
  `The range must be positive and at most ${MAX_EVENT_RANGE_DAYS} days`,
);

export const calendarInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: z.string().regex(/^#[0-9a-f]{6}$/iu).transform((value) => value.toLowerCase()),
});

export const calendarPatchSchema = calendarInputSchema.partial().extend({
  visible: z.boolean().optional(),
});

const rruleSchema = z.string().max(500).transform((value, context) => {
  const parsed = parseRecurrenceRule(value);
  if ("error" in parsed) {
    context.addIssue({ code: "custom", message: parsed.error });
    return z.NEVER;
  }
  return formatRecurrenceRule(parsed.rule);
});

const attendeeInputSchema = z.object({
  address: z.email().max(320),
  name: z.string().trim().max(200).optional(),
  role: z.enum(attendeeRoles).optional(),
});

const eventFieldsSchema = z.object({
  calendarId: z.string().min(1).max(100).optional(),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10_000).optional(),
  location: z.string().max(500).optional(),
  startsAt: instantSchema,
  endsAt: instantSchema,
  timeZone: z.string().max(100).refine(isValidTimeZone, "Unknown IANA time zone"),
  allDay: z.boolean().optional(),
  status: z.enum(calendarEventStatuses).optional(),
  transparency: z.enum(calendarTransparencies).optional(),
  rrule: rruleSchema.nullable().optional(),
  reminders: z.array(z.number().int().min(0).max(MAX_REMINDER_MINUTES))
    .max(MAX_REMINDERS_PER_EVENT)
    .transform((values) => [...new Set(values)].sort((a, b) => a - b))
    .optional(),
  attendees: z.array(attendeeInputSchema).max(MAX_ATTENDEES).optional().describe(
    "People to invite. Their answers are tracked per attendee.",
  ),
  mailboxId: z.string().min(1).max(100).nullable().optional().describe(
    "Mailbox the invitations are sent from (needs send access); it becomes the organizer.",
  ),
  sendInvitations: z.boolean().optional().describe(
    "Email invitations (iTIP REQUEST/CANCEL) to the attendees from mailboxId. Defaults to false.",
  ),
});

export function checkTimes(
  value: { startsAt?: number; endsAt?: number; allDay?: boolean },
  context: z.RefinementCtx,
) {
  if (value.startsAt === undefined || value.endsAt === undefined) return;
  if (value.endsAt < value.startsAt) {
    context.addIssue({ code: "custom", path: ["endsAt"], message: "endsAt must not be before startsAt" });
  }
  if (value.allDay && (
    value.startsAt % DAY_MS !== 0
    || value.endsAt % DAY_MS !== 0
    || value.endsAt <= value.startsAt
  )) {
    context.addIssue({
      code: "custom",
      path: ["startsAt"],
      message: "All-day events start and end at UTC midnight; the end is exclusive",
    });
  }
}

export const createEventSchema = eventFieldsSchema.superRefine(checkTimes);

export const updateEventFieldsSchema = eventFieldsSchema.partial().extend({
  scope: z.enum(calendarEditScopes).optional(),
  occurrenceStart: instantSchema.optional(),
});

export const updateEventSchema = updateEventFieldsSchema.superRefine(checkTimes);

export const deleteEventQuerySchema = z.object({
  scope: z.enum(calendarEditScopes).optional(),
  occurrenceStart: queryInstantSchema.optional(),
  sendInvitations: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
});

export const invitationResponseSchema = z.object({ response: z.enum(invitationResponses) });

export const importSchema = z.object({
  ics: z.string().min(1).max(2_000_000),
  timeZone: z.string().max(100).refine(isValidTimeZone, "Unknown IANA time zone").optional(),
});

export const calendarModuleSchema = z.object({ enabled: z.boolean() });

const timeRangeFields = {
  start: z.number().int().min(0).max(1_439),
  end: z.number().int().min(1).max(1_440),
};
const endsAfterStart = [
  (range: { start: number; end: number }) => range.end > range.start,
  "A range must end after it starts",
] as const;

const bookingTypeFieldsSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(BOOKING_SLUG_PATTERN, "Use lowercase letters, digits and dashes"),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000),
  location: z.string().max(500),
  durationMinutes: z.number().int().min(5).max(720),
  timeZone: z.string().max(100).refine(isValidTimeZone, "Unknown IANA time zone"),
  weeklyHours: z.array(z.object({ day: z.enum(weekdayCodes), ...timeRangeFields })
    .refine(...endsAfterStart)).max(70),
  dateOverrides: z.array(z.object({
    date: z.iso.date(),
    ranges: z.array(z.object(timeRangeFields).refine(...endsAfterStart)).max(10),
  })).max(400),
  bufferBeforeMinutes: z.number().int().min(0).max(720),
  bufferAfterMinutes: z.number().int().min(0).max(720),
  minimumNoticeMinutes: z.number().int().min(0).max(30 * 24 * 60),
  maxDaysAhead: z.number().int().min(1).max(365),
  slotIntervalMinutes: z.number().int().min(5).max(720),
  dailyCap: z.number().int().min(1).max(100).nullable(),
  collectNotes: z.boolean(),
  calendarId: z.string().min(1).max(100).nullable(),
  senderMailboxId: z.string().min(1).max(100).nullable(),
  enabled: z.boolean(),
});

/** Omitted fields take the column defaults; the interval defaults to the duration. */
export const createBookingTypeSchema = bookingTypeFieldsSchema
  .partial()
  .required({ slug: true, name: true, durationMinutes: true, timeZone: true });

export const bookingTypePatchSchema = bookingTypeFieldsSchema.partial();

export const bookingSlotsQuerySchema = z.object({
  from: queryInstantSchema,
  to: queryInstantSchema,
}).refine(
  (value) => value.to > value.from && value.to - value.from <= MAX_BOOKING_SLOT_RANGE_DAYS * DAY_MS,
  `The range must be positive and at most ${MAX_BOOKING_SLOT_RANGE_DAYS} days`,
);

export const bookingRequestSchema = z.object({
  start: instantSchema,
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  notes: z.string().trim().max(2_000).default(""),
  timeZone: z.string().max(100).refine(isValidTimeZone, "Unknown IANA time zone"),
  /** Honeypot: hidden from people, filled in by naive bots. */
  website: z.string().max(500).default(""),
  turnstileToken: z.string().max(2_048).default(""),
});

export const rescheduleRequestSchema = z.object({ start: instantSchema });

export const bookingHandleSchema = z.object({
  handle: z.string().trim().toLowerCase()
    .refine(isValidBookingHandle, "Use 3–40 lowercase letters, digits and dashes"),
});
