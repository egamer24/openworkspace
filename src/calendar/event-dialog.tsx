import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  formatRecurrenceRule,
  parseRecurrenceRule,
  wallClock,
  weekdayCodes,
  zonedToUtc,
  type CalendarEditScope,
  type RecurrenceFrequency,
  type WeekdayCode,
} from "../../shared/calendar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, responseJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { CalendarItem, CalendarOccurrence } from "./types";

const DAY = 86_400_000;
const weekdayLabels: Record<WeekdayCode, string> = {
  MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun",
};
const repeatLabels = {
  none: "Does not repeat",
  daily: "Every day",
  weekdays: "Every weekday (Mon–Fri)",
  weekly: "Every week",
  monthly: "Every month",
  yearly: "Every year",
  custom: "Custom…",
} as const;
type RepeatPreset = keyof typeof repeatLabels;
const reminderLabels: Record<string, string> = {
  none: "No reminder",
  "0": "At start time",
  "5": "5 minutes before",
  "10": "10 minutes before",
  "15": "15 minutes before",
  "30": "30 minutes before",
  "60": "1 hour before",
  "1440": "1 day before",
};
const scopeLabels: Record<CalendarEditScope, string> = {
  this: "This event",
  following: "This and following events",
  all: "All events",
};
const frequencyLabels: Record<RecurrenceFrequency, string> = {
  DAILY: "days",
  WEEKLY: "weeks",
  MONTHLY: "months",
  YEARLY: "years",
};

const pad = (value: number) => String(value).padStart(2, "0");
const dateValue = (clock: { year: number; month: number; day: number }) =>
  `${clock.year}-${pad(clock.month)}-${pad(clock.day)}`;
const timeValue = (clock: { hour: number; minute: number }) => `${pad(clock.hour)}:${pad(clock.minute)}`;

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

function parseTime(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return { hour: hour ?? 0, minute: minute ?? 0, second: 0 };
}

const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const timeZones = Intl.supportedValuesOf("timeZone");

type CustomRule = {
  freq: RecurrenceFrequency;
  interval: number;
  byDay: WeekdayCode[];
  ends: "never" | "until" | "count";
  until: string;
  count: number;
};

type Draft = {
  title: string;
  calendarId: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  timeZone: string;
  location: string;
  description: string;
  repeat: RepeatPreset;
  custom: CustomRule;
  reminder: string;
  transparency: "busy" | "free";
};

function weekdayOf(date: string): WeekdayCode {
  const { year, month, day } = parseDate(date);
  return weekdayCodes[(new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7]!;
}

/** The preset that would produce exactly this rule, or "custom". */
function presetFor(rrule: string | null, draft: Draft): RepeatPreset {
  if (!rrule) return "none";
  const presets = ["daily", "weekdays", "weekly", "monthly", "yearly"] as const;
  return presets.find((repeat) => ruleFromDraft({ ...draft, repeat }) === rrule) ?? "custom";
}

function initialDraft(
  occurrence: CalendarOccurrence | null,
  start: number,
  calendars: CalendarItem[],
): Draft {
  const timeZone = occurrence?.timeZone ?? browserTimeZone;
  const allDay = occurrence?.allDay ?? false;
  const startsAt = occurrence?.startsAt ?? start;
  const endsAt = occurrence?.endsAt ?? start + 3_600_000;
  const startClock = wallClock(startsAt, allDay ? "UTC" : timeZone);
  const endClock = wallClock(allDay ? endsAt - DAY : endsAt, allDay ? "UTC" : timeZone);
  const parsed = occurrence?.rrule ? parseRecurrenceRule(occurrence.rrule) : null;
  const rule = parsed && "rule" in parsed ? parsed.rule : null;
  const startDate = dateValue(startClock);
  const draft: Draft = {
    title: occurrence?.title ?? "",
    calendarId: occurrence?.calendarId ?? calendars.find((item) => item.visible)?.id ?? calendars[0]?.id ?? "",
    allDay,
    startDate,
    startTime: timeValue(startClock),
    endDate: dateValue(endClock),
    endTime: timeValue(endClock),
    timeZone,
    location: occurrence?.location ?? "",
    description: occurrence?.description ?? "",
    repeat: "custom",
    custom: {
      freq: rule?.freq ?? "WEEKLY",
      interval: rule?.interval ?? 1,
      byDay: (rule?.byDay?.filter((day): day is WeekdayCode =>
        weekdayCodes.includes(day as WeekdayCode)) ?? [weekdayOf(startDate)]),
      ends: rule?.until ? "until" : rule?.count ? "count" : "never",
      until: rule?.until
        ? dateValue(wallClock(Date.parse(rule.until.replace(
          /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u,
          "$1-$2-$3T$4:$5:$6Z",
        )), allDay ? "UTC" : timeZone))
        : startDate,
      count: rule?.count ?? 10,
    },
    reminder: occurrence ? String(occurrence.reminders[0] ?? "none") : "10",
    transparency: occurrence?.transparency ?? "busy",
  };
  return { ...draft, repeat: presetFor(occurrence?.rrule ?? null, draft) };
}

function ruleFromDraft(draft: Draft): string | null {
  const zone = draft.allDay ? "UTC" : draft.timeZone;
  switch (draft.repeat) {
    case "none": return null;
    case "daily": return formatRecurrenceRule({ freq: "DAILY", interval: 1 });
    case "weekdays": return formatRecurrenceRule({ freq: "WEEKLY", interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"] });
    case "weekly": return formatRecurrenceRule({ freq: "WEEKLY", interval: 1, byDay: [weekdayOf(draft.startDate)] });
    case "monthly": return formatRecurrenceRule({ freq: "MONTHLY", interval: 1, byMonthDay: [parseDate(draft.startDate).day] });
    case "yearly": return formatRecurrenceRule({ freq: "YEARLY", interval: 1 });
    case "custom": {
      const { custom } = draft;
      const untilMs = zonedToUtc({ ...parseDate(custom.until), hour: 23, minute: 59, second: 59 }, zone);
      return formatRecurrenceRule({
        freq: custom.freq,
        interval: Math.max(1, Math.min(999, Math.round(custom.interval) || 1)),
        byDay: custom.freq === "WEEKLY" && custom.byDay.length
          ? weekdayCodes.filter((day) => custom.byDay.includes(day))
          : undefined,
        count: custom.ends === "count" ? Math.max(1, Math.round(custom.count) || 1) : undefined,
        until: custom.ends === "until"
          ? new Date(untilMs).toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}/u, "")
          : undefined,
      });
    }
  }
}

function timesFromDraft(draft: Draft) {
  if (draft.allDay) {
    const start = parseDate(draft.startDate);
    const end = parseDate(draft.endDate);
    return {
      startsAt: Date.UTC(start.year, start.month - 1, start.day),
      endsAt: Date.UTC(end.year, end.month - 1, end.day) + DAY,
    };
  }
  return {
    startsAt: zonedToUtc({ ...parseDate(draft.startDate), ...parseTime(draft.startTime) }, draft.timeZone),
    endsAt: zonedToUtc({ ...parseDate(draft.endDate), ...parseTime(draft.endTime) }, draft.timeZone),
  };
}

export function EventDialog({
  open,
  occurrence,
  start,
  calendars,
  onOpenChange,
}: {
  open: boolean;
  /** Editing this occurrence; null creates a new event. */
  occurrence: CalendarOccurrence | null;
  /** Suggested start for new events. */
  start: number;
  calendars: CalendarItem[];
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        {open ? (
          <EventForm
            key={`${occurrence?.eventId ?? "new"}-${occurrence?.startsAt ?? start}`}
            occurrence={occurrence}
            start={start}
            calendars={calendars}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EventForm({
  occurrence,
  start,
  calendars,
  onDone,
}: {
  occurrence: CalendarOccurrence | null;
  start: number;
  calendars: CalendarItem[];
  onDone: () => void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(() => initialDraft(occurrence, start, calendars));
  const recurring = Boolean(occurrence?.seriesId);
  const [scope, setScope] = useState<CalendarEditScope>("this");
  const [repeatTouched, setRepeatTouched] = useState(false);
  const update = (patch: Partial<Draft>) => {
    if ("repeat" in patch || "custom" in patch) setRepeatTouched(true);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const rrule = ruleFromDraft(draft);
  // Rules the editor cannot express exactly stay untouched unless edited.
  const ruleChanged = occurrence
    ? repeatTouched && rrule !== (occurrence.rrule ?? null)
    : true;
  const effectiveScope = ruleChanged && scope === "this" ? "all" : scope;

  const save = useMutation({
    mutationFn: async () => {
      const times = timesFromDraft(draft);
      if (times.endsAt < times.startsAt) throw new Error("The event ends before it starts");
      const reminders = draft.reminder === "none" ? [] : [Number(draft.reminder)];
      const fields = {
        title: draft.title.trim() || "(no title)",
        location: draft.location,
        description: draft.description,
        allDay: draft.allDay,
        timeZone: draft.timeZone,
        transparency: draft.transparency,
        ...times,
      };
      if (!occurrence) {
        return responseJson(await api.api.calendar.events.$post({
          json: { ...fields, calendarId: draft.calendarId, rrule, reminders },
        }));
      }
      return responseJson(await api.api.calendar.events[":eventId"].$patch({
        param: { eventId: occurrence.eventId },
        json: {
          ...fields,
          ...(draft.calendarId !== occurrence.calendarId ? { calendarId: draft.calendarId } : {}),
          ...(ruleChanged ? { rrule } : {}),
          ...(reminders.join() !== occurrence.reminders.join() ? { reminders } : {}),
          ...(recurring
            ? { scope: effectiveScope, occurrenceStart: occurrence.occurrenceStart ?? undefined }
            : {}),
        },
      }));
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["calendar"] });
      onDone();
    },
    onError: (error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: async () => responseJson(await api.api.calendar.events[":eventId"].$delete({
      param: { eventId: occurrence!.eventId },
      query: recurring
        ? { scope, occurrenceStart: String(occurrence!.occurrenceStart ?? "") || undefined }
        : {},
    })),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["calendar"] });
      onDone();
    },
    onError: (error) => toast.error(error.message),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  const pending = save.isPending || remove.isPending;

  return (
    <form className="space-y-4" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{occurrence ? "Edit event" : "New event"}</DialogTitle>
      </DialogHeader>
      <Input
        aria-label="Title"
        autoFocus
        maxLength={500}
        placeholder="Add title"
        value={draft.title}
        onChange={(event) => update({ title: event.target.value })}
      />

      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="event-all-day">All day</Label>
        <Switch
          id="event-all-day"
          checked={draft.allDay}
          onCheckedChange={(checked) => update({ allDay: checked })}
        />
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_auto_1fr_auto]">
        <Input
          type="date"
          aria-label="Start date"
          required
          value={draft.startDate}
          onChange={(event) => {
            const value = event.target.value;
            if (value) update({ startDate: value, endDate: value > draft.endDate ? value : draft.endDate });
          }}
        />
        <Input
          type="time"
          aria-label="Start time"
          className={cn(draft.allDay && "invisible")}
          disabled={draft.allDay}
          required={!draft.allDay}
          value={draft.startTime}
          onChange={(event) => update({ startTime: event.target.value })}
        />
        <Input
          type="date"
          aria-label="End date"
          required
          min={draft.startDate}
          value={draft.endDate}
          onChange={(event) => event.target.value && update({ endDate: event.target.value })}
        />
        <Input
          type="time"
          aria-label="End time"
          className={cn(draft.allDay && "invisible")}
          disabled={draft.allDay}
          required={!draft.allDay}
          value={draft.endTime}
          onChange={(event) => update({ endTime: event.target.value })}
        />
      </div>

      {!draft.allDay && (
        <div className="space-y-1.5">
          <Label htmlFor="event-time-zone">Time zone</Label>
          <Input
            id="event-time-zone"
            list="calendar-time-zones"
            value={draft.timeZone}
            onChange={(event) => update({ timeZone: event.target.value })}
            onBlur={() => {
              if (!timeZones.includes(draft.timeZone)) update({ timeZone: browserTimeZone });
            }}
          />
          <datalist id="calendar-time-zones">
            {timeZones.map((zone) => <option key={zone} value={zone} />)}
          </datalist>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Repeat</Label>
          <Select value={draft.repeat} onValueChange={(value) => value && update({ repeat: value as RepeatPreset })}>
            <SelectTrigger className="w-full" aria-label="Repeat">
              <SelectValue>{repeatLabels[draft.repeat]}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              {Object.entries(repeatLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Calendar</Label>
          <Select value={draft.calendarId} onValueChange={(value) => value && update({ calendarId: value })}>
            <SelectTrigger className="w-full" aria-label="Calendar">
              <SelectValue>{calendars.find((item) => item.id === draft.calendarId)?.name}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              {calendars.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  <span className="size-2.5 rounded-full" style={{ background: item.color }} />
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {draft.repeat === "custom" && (
        <RecurrenceEditor
          value={draft.custom}
          onChange={(custom) => update({ custom })}
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Reminder</Label>
          <Select value={draft.reminder} onValueChange={(value) => value && update({ reminder: value })}>
            <SelectTrigger className="w-full" aria-label="Reminder">
              <SelectValue>{reminderLabels[draft.reminder] ?? `${draft.reminder} minutes before`}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              {Object.entries(reminderLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Show as</Label>
          <Select
            value={draft.transparency}
            onValueChange={(value) => value && update({ transparency: value as Draft["transparency"] })}
          >
            <SelectTrigger className="w-full" aria-label="Show as">
              <SelectValue>{draft.transparency === "busy" ? "Busy" : "Free"}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              <SelectItem value="busy">Busy</SelectItem>
              <SelectItem value="free">Free</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Input
        aria-label="Location"
        maxLength={500}
        placeholder="Location"
        value={draft.location}
        onChange={(event) => update({ location: event.target.value })}
      />
      <Textarea
        aria-label="Description"
        maxLength={10_000}
        placeholder="Description"
        rows={3}
        value={draft.description}
        onChange={(event) => update({ description: event.target.value })}
      />

      {recurring && (
        <div className="space-y-1.5">
          <Label>Apply changes to</Label>
          <Select value={effectiveScope} onValueChange={(value) => value && setScope(value as CalendarEditScope)}>
            <SelectTrigger className="w-full" aria-label="Apply changes to">
              <SelectValue>{scopeLabels[effectiveScope]}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              {Object.entries(scopeLabels).map(([value, label]) => (
                <SelectItem key={value} value={value} disabled={value === "this" && ruleChanged}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <DialogFooter className="sm:justify-between">
        {occurrence ? (
          <Button type="button" variant="destructive" disabled={pending} onClick={() => remove.mutate()}>
            {remove.isPending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
            Delete
          </Button>
        ) : <span />}
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
          <Button type="submit" disabled={pending || !draft.calendarId}>
            {save.isPending && <LoaderCircle className="animate-spin" />}
            Save
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}

function RecurrenceEditor({
  value,
  onChange,
}: {
  value: CustomRule;
  onChange: (value: CustomRule) => void;
}) {
  const set = (patch: Partial<CustomRule>) => onChange({ ...value, ...patch });
  return (
    <fieldset className="space-y-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-xs font-semibold text-muted-foreground">Custom recurrence</legend>
      <div className="flex items-center gap-2 text-sm">
        <span>Every</span>
        <Input
          type="number"
          aria-label="Repeat interval"
          className="w-20"
          min={1}
          max={999}
          value={value.interval}
          onChange={(event) => set({ interval: Number(event.target.value) })}
        />
        <Select value={value.freq} onValueChange={(freq) => freq && set({ freq: freq as RecurrenceFrequency })}>
          <SelectTrigger className="w-32" aria-label="Repeat unit">
            <SelectValue>{frequencyLabels[value.freq]}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            {Object.entries(frequencyLabels).map(([freq, label]) => (
              <SelectItem key={freq} value={freq}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {value.freq === "WEEKLY" && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Repeat on">
          {weekdayCodes.map((day) => {
            const active = value.byDay.includes(day);
            return (
              <Button
                key={day}
                type="button"
                size="xs"
                variant={active ? "default" : "outline"}
                aria-pressed={active}
                onClick={() => set({
                  byDay: active ? value.byDay.filter((item) => item !== day) : [...value.byDay, day],
                })}
              >
                {weekdayLabels[day]}
              </Button>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>Ends</span>
        <Select value={value.ends} onValueChange={(ends) => ends && set({ ends: ends as CustomRule["ends"] })}>
          <SelectTrigger className="w-32" aria-label="Ends">
            <SelectValue>{{ never: "Never", until: "On date", count: "After" }[value.ends]}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            <SelectItem value="never">Never</SelectItem>
            <SelectItem value="until">On date</SelectItem>
            <SelectItem value="count">After</SelectItem>
          </SelectContent>
        </Select>
        {value.ends === "until" && (
          <Input
            type="date"
            aria-label="Last date"
            className="w-44"
            value={value.until}
            onChange={(event) => event.target.value && set({ until: event.target.value })}
          />
        )}
        {value.ends === "count" && (
          <>
            <Input
              type="number"
              aria-label="Number of occurrences"
              className="w-20"
              min={1}
              max={5000}
              value={value.count}
              onChange={(event) => set({ count: Number(event.target.value) })}
            />
            <span>times</span>
          </>
        )}
      </div>
    </fieldset>
  );
}
