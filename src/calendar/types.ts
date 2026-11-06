import type { api, SuccessfulResponse } from "@/lib/api";

export type CalendarItem = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.calendar.calendars.$get>>
>["calendars"][number];

export type CalendarOccurrence = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.calendar.events.$get>>
>["events"][number];
