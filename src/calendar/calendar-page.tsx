import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addDays,
  addMonths,
  addWeeks,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import {
  ArrowLeft,
  CalendarCheck,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Copy,
  EllipsisVertical,
  FileUp,
  Link2Off,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, responseJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { BookingPanel } from "./booking-panel";
import { EventDialog } from "./event-dialog";
import type { CalendarItem, CalendarOccurrence } from "./types";

type CalendarView = "month" | "week" | "agenda";
const WEEK = { weekStartsOn: 1 } as const;
const HOUR_HEIGHT = 48;
const AGENDA_DAYS = 30;
const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Local dates an occurrence covers; all-day events keep their UTC date. */
function occurrenceBounds(occurrence: CalendarOccurrence) {
  if (!occurrence.allDay) {
    return { start: new Date(occurrence.startsAt), end: new Date(occurrence.endsAt) };
  }
  const local = (ms: number) => {
    const date = new Date(ms);
    return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  };
  return { start: local(occurrence.startsAt), end: local(occurrence.endsAt) };
}

function coversDay(occurrence: CalendarOccurrence, day: Date) {
  const { start, end } = occurrenceBounds(occurrence);
  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(day, 1).getTime();
  return start.getTime() < dayEnd && Math.max(end.getTime(), start.getTime() + 1) > dayStart;
}

function visibleRange(view: CalendarView, cursor: Date) {
  if (view === "month") {
    return { from: startOfWeek(startOfMonth(cursor), WEEK), to: addDays(endOfWeek(endOfMonth(cursor), WEEK), 1) };
  }
  if (view === "week") {
    const from = startOfWeek(cursor, WEEK);
    return { from, to: addDays(from, 7) };
  }
  const from = startOfDay(cursor);
  return { from, to: addDays(from, AGENDA_DAYS) };
}

function timeLabel(occurrence: CalendarOccurrence) {
  return occurrence.allDay ? "All day" : format(occurrence.startsAt, "p");
}

export function CalendarPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [view, setView] = useState<CalendarView>("month");
  const [cursor, setCursor] = useState(() => new Date());
  const [dialog, setDialog] = useState<{ occurrence: CalendarOccurrence | null; start: number } | null>(null);
  const [bookingOpen, setBookingOpen] = useState(false);
  const range = visibleRange(view, cursor);

  const calendars = useQuery({
    queryKey: ["calendar", "calendars"],
    queryFn: async () => (await responseJson(await api.api.calendar.calendars.$get())).calendars,
  });
  const events = useQuery({
    queryKey: ["calendar", "events", range.from.getTime(), range.to.getTime()],
    queryFn: async () => (await responseJson(await api.api.calendar.events.$get({
      query: { from: String(range.from.getTime()), to: String(range.to.getTime()) },
    }))).events,
    placeholderData: (previous) => previous,
  });
  const colors = useMemo(
    () => new Map((calendars.data ?? []).map((item) => [item.id, item.color])),
    [calendars.data],
  );
  const shown = useMemo(() => {
    const visible = new Set((calendars.data ?? []).filter((item) => item.visible).map((item) => item.id));
    return (events.data ?? []).filter((item) => visible.has(item.calendarId));
  }, [calendars.data, events.data]);

  const step = (direction: 1 | -1) => setCursor((current) =>
    view === "month" ? addMonths(current, direction)
      : view === "week" ? addWeeks(current, direction)
        : addDays(current, direction * AGENDA_DAYS));
  const title = view === "month"
    ? format(cursor, "MMMM yyyy")
    : `${format(range.from, "MMM d")} – ${format(addDays(range.to, -1), "MMM d, yyyy")}`;
  const createAt = (start: Date) => setDialog({ occurrence: null, start: start.getTime() });
  const open = (occurrence: CalendarOccurrence) => setDialog({ occurrence, start: occurrence.startsAt });

  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 sm:px-5">
        <Button variant="ghost" size="icon" aria-label="Back to mail" onClick={() => navigate("/")}>
          <ArrowLeft />
        </Button>
        <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
          <CalendarDays className="size-4.5" strokeWidth={2.25} />
        </span>
        <span className="mr-2 hidden text-sm font-semibold sm:inline">Calendar</span>
        <Button variant="outline" size="sm" onClick={() => setCursor(new Date())}>Today</Button>
        <Button variant="ghost" size="icon-sm" aria-label="Previous" onClick={() => step(-1)}><ChevronLeft /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Next" onClick={() => step(1)}><ChevronRight /></Button>
        <h1 className="min-w-0 truncate text-sm font-semibold sm:text-base">{title}</h1>
        <div className="ml-auto flex items-center gap-2">
          <Tabs value={view} onValueChange={(value) => setView(value as CalendarView)}>
            <TabsList>
              <TabsTrigger value="month">Month</TabsTrigger>
              <TabsTrigger value="week">Week</TabsTrigger>
              <TabsTrigger value="agenda">Agenda</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="ghost" size="icon" aria-label="Booking pages" onClick={() => setBookingOpen(true)}>
            <CalendarCheck />
          </Button>
          <Button
            className="hidden sm:inline-flex"
            disabled={!calendars.data?.length}
            onClick={() => {
              const start = new Date(cursor);
              start.setHours(9, 0, 0, 0);
              createAt(start);
            }}
          >
            <Plus /> New event
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 overflow-y-auto border-r border-border bg-surface p-4 lg:block">
          <CalendarList calendars={calendars.data ?? []} />
        </aside>
        <main className="min-w-0 flex-1 overflow-auto" aria-busy={events.isFetching}>
          {view === "month" && (
            <MonthView cursor={cursor} events={shown} colors={colors} onCreate={createAt} onOpen={open}
              onShowDay={(day) => { setCursor(day); setView("agenda"); }} />
          )}
          {view === "week" && (
            <WeekView from={range.from} events={shown} colors={colors} onCreate={createAt} onOpen={open} />
          )}
          {view === "agenda" && (
            <AgendaView from={range.from} events={shown} colors={colors} onOpen={open} />
          )}
          <div className="border-t border-border p-4 lg:hidden">
            <CalendarList calendars={calendars.data ?? []} />
          </div>
        </main>
      </div>
      <Button
        className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] size-12 rounded-full shadow-lg sm:hidden"
        aria-label="New event"
        disabled={!calendars.data?.length}
        onClick={() => {
          const start = new Date(cursor);
          start.setHours(9, 0, 0, 0);
          createAt(start);
        }}
      >
        <Plus />
      </Button>
      <BookingPanel open={bookingOpen} onOpenChange={setBookingOpen} calendars={calendars.data ?? []} />
      <EventDialog
        open={dialog !== null}
        occurrence={dialog?.occurrence ?? null}
        start={dialog?.start ?? Date.now()}
        calendars={calendars.data ?? []}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
          void client.invalidateQueries({ queryKey: ["calendar", "events"] });
        }}
      />
    </div>
  );
}

function EventChip({
  occurrence,
  color,
  onOpen,
}: {
  occurrence: CalendarOccurrence;
  color: string | undefined;
  onOpen: (occurrence: CalendarOccurrence) => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs hover:bg-accent",
        occurrence.status === "cancelled" && "line-through opacity-60",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(occurrence);
      }}
    >
      <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="shrink-0 text-muted-foreground tabular-nums">{timeLabel(occurrence)}</span>
      <span className="truncate font-medium">{occurrence.title}</span>
    </button>
  );
}

function MonthView({
  cursor,
  events,
  colors,
  onCreate,
  onOpen,
  onShowDay,
}: {
  cursor: Date;
  events: CalendarOccurrence[];
  colors: Map<string, string>;
  onCreate: (start: Date) => void;
  onOpen: (occurrence: CalendarOccurrence) => void;
  onShowDay: (day: Date) => void;
}) {
  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(cursor), WEEK),
    end: endOfWeek(endOfMonth(cursor), WEEK),
  });
  return (
    <div className="grid min-h-full min-w-[42rem] grid-cols-7 grid-rows-[auto] auto-rows-[minmax(6.5rem,1fr)]">
      {days.slice(0, 7).map((day) => (
        <div key={`head-${day.getTime()}`} className="border-b border-border px-2 py-1.5 text-xs font-semibold text-muted-foreground">
          {format(day, "EEE")}
        </div>
      ))}
      {days.map((day) => {
        const dayEvents = events
          .filter((item) => coversDay(item, day))
          .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt - b.startsAt);
        return (
          <div
            key={day.getTime()}
            role="button"
            tabIndex={0}
            aria-label={`Create event on ${format(day, "PPPP")}`}
            className={cn(
              "min-w-0 cursor-pointer border-r border-b border-border p-1 outline-none hover:bg-accent/40 focus-visible:bg-accent/40",
              !isSameMonth(day, cursor) && "bg-surface-sunken/60 text-muted-foreground",
            )}
            onClick={() => {
              const start = new Date(day);
              start.setHours(9, 0, 0, 0);
              onCreate(start);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.click();
            }}
          >
            <div className={cn(
              "mb-0.5 grid size-6 place-items-center rounded-full text-xs tabular-nums",
              isToday(day) && "bg-primary font-semibold text-primary-foreground",
            )}>
              {format(day, "d")}
            </div>
            {dayEvents.slice(0, 3).map((item) => (
              <EventChip key={`${item.eventId}-${item.startsAt}`} occurrence={item} color={colors.get(item.calendarId)} onOpen={onOpen} />
            ))}
            {dayEvents.length > 3 && (
              <button
                type="button"
                className="px-1.5 text-xs font-medium text-muted-foreground hover:underline"
                onClick={(event) => {
                  event.stopPropagation();
                  onShowDay(day);
                }}
              >
                +{dayEvents.length - 3} more
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Greedy lanes so overlapping events sit side by side. */
function layoutDay(events: CalendarOccurrence[], day: Date) {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(day, 1).getTime();
  const items = events
    .map((occurrence) => ({
      occurrence,
      start: Math.max(occurrence.startsAt, dayStart),
      end: Math.min(Math.max(occurrence.endsAt, occurrence.startsAt + 15 * 60_000), dayEnd),
      lane: 0,
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const laneEnds: number[] = [];
  for (const item of items) {
    const free = laneEnds.findIndex((end) => end <= item.start);
    item.lane = free === -1 ? laneEnds.length : free;
    laneEnds[item.lane] = item.end;
  }
  return { items, lanes: Math.max(1, laneEnds.length), dayStart };
}

function WeekView({
  from,
  events,
  colors,
  onCreate,
  onOpen,
}: {
  from: Date;
  events: CalendarOccurrence[];
  colors: Map<string, string>;
  onCreate: (start: Date) => void;
  onOpen: (occurrence: CalendarOccurrence) => void;
}) {
  const days = Array.from({ length: 7 }, (_, index) => addDays(from, index));
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  return (
    <div className="min-w-[48rem]">
      <div className="sticky top-0 z-10 grid grid-cols-[3.5rem_repeat(7,1fr)] border-b border-border bg-surface">
        <div />
        {days.map((day) => (
          <div key={day.getTime()} className="border-l border-border px-2 py-1.5 text-xs">
            <span className="font-semibold text-muted-foreground">{format(day, "EEE")} </span>
            <span className={cn("tabular-nums", isToday(day) && "font-bold text-primary")}>{format(day, "d")}</span>
            <div className="mt-1 space-y-0.5">
              {events.filter((item) => item.allDay && coversDay(item, day)).map((item) => (
                <EventChip key={`${item.eventId}-${item.startsAt}`} occurrence={item} color={colors.get(item.calendarId)} onOpen={onOpen} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-[3.5rem_repeat(7,1fr)]">
        <div>
          {hours.map((hour) => (
            <div key={hour} className="pr-2 text-right text-[11px] text-muted-foreground" style={{ height: HOUR_HEIGHT }}>
              {hour ? format(new Date(2000, 0, 1, hour), "p") : ""}
            </div>
          ))}
        </div>
        {days.map((day) => {
          const { items, lanes, dayStart } = layoutDay(
            events.filter((item) => !item.allDay && coversDay(item, day)),
            day,
          );
          return (
            <div key={day.getTime()} className="relative border-l border-border">
              {hours.map((hour) => (
                <button
                  key={hour}
                  type="button"
                  aria-label={`Create event on ${format(day, "PPP")} at ${hour}:00`}
                  className="block w-full border-b border-border/60 hover:bg-accent/40"
                  style={{ height: HOUR_HEIGHT }}
                  onClick={() => {
                    const start = new Date(day);
                    start.setHours(hour, 0, 0, 0);
                    onCreate(start);
                  }}
                />
              ))}
              {items.map(({ occurrence, start, end, lane }) => (
                <button
                  key={`${occurrence.eventId}-${occurrence.startsAt}`}
                  type="button"
                  className={cn(
                    "absolute overflow-hidden rounded-md border border-surface px-1.5 py-0.5 text-left text-[11px] leading-tight text-white shadow-xs",
                    occurrence.status === "cancelled" && "line-through opacity-60",
                  )}
                  style={{
                    top: ((start - dayStart) / 3_600_000) * HOUR_HEIGHT,
                    height: Math.max(18, ((end - start) / 3_600_000) * HOUR_HEIGHT),
                    left: `${(lane / lanes) * 100}%`,
                    width: `${100 / lanes}%`,
                    background: colors.get(occurrence.calendarId),
                  }}
                  onClick={() => onOpen(occurrence)}
                >
                  <span className="block truncate font-semibold">{occurrence.title}</span>
                  <span className="block truncate opacity-90">{format(occurrence.startsAt, "p")}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgendaView({
  from,
  events,
  colors,
  onOpen,
}: {
  from: Date;
  events: CalendarOccurrence[];
  colors: Map<string, string>;
  onOpen: (occurrence: CalendarOccurrence) => void;
}) {
  const days = Array.from({ length: AGENDA_DAYS }, (_, index) => addDays(from, index))
    .map((day) => ({ day, items: events.filter((item) => coversDay(item, day)) }))
    .filter((entry) => entry.items.length);
  if (!days.length) {
    return <p className="p-8 text-center text-sm text-muted-foreground">No events in the next {AGENDA_DAYS} days.</p>;
  }
  return (
    <div className="mx-auto max-w-3xl divide-y divide-border px-4">
      {days.map(({ day, items }) => (
        <section key={day.getTime()} className="flex gap-4 py-3">
          <h2 className={cn("w-24 shrink-0 text-sm font-semibold", isSameDay(day, new Date()) && "text-primary")}>
            {format(day, "EEE, MMM d")}
          </h2>
          <ul className="min-w-0 flex-1 space-y-1">
            {items.map((item) => (
              <li key={`${item.eventId}-${item.startsAt}`}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={() => onOpen(item)}
                >
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: colors.get(item.calendarId) }} />
                  <span className="w-28 shrink-0 text-muted-foreground tabular-nums">
                    {item.allDay ? "All day" : `${format(item.startsAt, "p")} – ${format(item.endsAt, "p")}`}
                  </span>
                  <span className="min-w-0 truncate font-medium">{item.title}</span>
                  {item.location && <span className="hidden truncate text-muted-foreground sm:inline">{item.location}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function CalendarList({ calendars }: { calendars: CalendarItem[] }) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#16a34a");
  const importInput = useRef<HTMLInputElement>(null);
  const [importTarget, setImportTarget] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["calendar"] });
  const onError = (error: Error) => toast.error(error.message);

  const create = useMutation({
    mutationFn: async () => responseJson(await api.api.calendar.calendars.$post({ json: { name, color } })),
    onSuccess: async () => {
      setName("");
      await refresh();
    },
    onError,
  });
  const patch = useMutation({
    mutationFn: async (input: { id: string; visible?: boolean; color?: string }) => {
      const { id, ...json } = input;
      return responseJson(await api.api.calendar.calendars[":calendarId"].$patch({ param: { calendarId: id }, json }));
    },
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      responseJson(await api.api.calendar.calendars[":calendarId"].$delete({ param: { calendarId: id } })),
    onSuccess: refresh,
    onError,
  });
  const feed = useMutation({
    mutationFn: async (input: { id: string; action: "create" | "revoke" }) => {
      const param = { calendarId: input.id };
      if (input.action === "revoke") {
        await responseJson(await api.api.calendar.calendars[":calendarId"].feed.$delete({ param }));
        return null;
      }
      return (await responseJson(await api.api.calendar.calendars[":calendarId"].feed.$post({ param }))).feedUrl;
    },
    onSuccess: async (url) => {
      if (url) await copy(url);
      else toast.success("Feed URL revoked");
      await refresh();
    },
    onError,
  });
  const importIcs = useMutation({
    mutationFn: async (input: { id: string; file: File }) => responseJson(
      await api.api.calendar.calendars[":calendarId"].import.$post({
        param: { calendarId: input.id },
        json: { ics: await input.file.text(), timeZone: browserTimeZone },
      }),
    ),
    onSuccess: async (report) => {
      const skipped = report.skipped.length;
      toast.success(`Imported ${report.imported} event${report.imported === 1 ? "" : "s"}`, {
        description: skipped
          ? `Skipped ${skipped}: ${report.skipped.slice(0, 3).map((item) => `${item.title ?? item.uid ?? "event"} (${item.reason})`).join("; ")}`
          : undefined,
      });
      await refresh();
    },
    onError,
  });

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Feed URL copied", { description: "Anyone with this link can read the calendar." });
    } catch {
      toast.message("Feed URL", { description: url });
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) create.mutate();
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Calendars</h2>
      <ul className="space-y-1">
        {calendars.map((calendar) => (
          <li key={calendar.id} className="flex items-center gap-2">
            <Checkbox
              aria-label={`Show ${calendar.name}`}
              checked={calendar.visible}
              style={{ background: calendar.visible ? calendar.color : undefined, borderColor: calendar.color }}
              onCheckedChange={(checked) => patch.mutate({ id: calendar.id, visible: checked })}
            />
            <span className="min-w-0 flex-1 truncate text-sm">{calendar.name}</span>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-xs" aria-label={`${calendar.name} options`} />}
              >
                <EllipsisVertical />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {calendar.feedUrl ? (
                  <>
                    <DropdownMenuItem onClick={() => void copy(calendar.feedUrl!)}><Copy />Copy ICS feed URL</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => feed.mutate({ id: calendar.id, action: "create" })}>
                      <RefreshCw />New feed URL
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => feed.mutate({ id: calendar.id, action: "revoke" })}>
                      <Link2Off />Revoke feed URL
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem onClick={() => feed.mutate({ id: calendar.id, action: "create" })}>
                    <Copy />Copy ICS feed URL
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => {
                  setImportTarget(calendar.id);
                  importInput.current?.click();
                }}>
                  <FileUp />Import .ics file
                </DropdownMenuItem>
                <label className="flex items-center gap-2 px-2 py-1.5 text-sm">
                  <input
                    type="color"
                    aria-label={`${calendar.name} color`}
                    className="size-5 cursor-pointer rounded border-0 bg-transparent p-0"
                    defaultValue={calendar.color}
                    onChange={(event) => patch.mutate({ id: calendar.id, color: event.target.value })}
                  />
                  Color
                </label>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    if (window.confirm(`Delete ${calendar.name} and all of its events?`)) remove.mutate(calendar.id);
                  }}
                >
                  <Trash2 />Delete calendar
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
      <form className="flex items-center gap-2" onSubmit={submit}>
        <input
          type="color"
          aria-label="New calendar color"
          className="size-8 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
          value={color}
          onChange={(event) => setColor(event.target.value)}
        />
        <Input
          aria-label="New calendar name"
          maxLength={80}
          placeholder="New calendar"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" size="icon" variant="outline" aria-label="Add calendar" disabled={!name.trim() || create.isPending}>
          <Plus />
        </Button>
      </form>
      <input
        ref={importInput}
        type="file"
        accept=".ics,text/calendar"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file && importTarget) importIcs.mutate({ id: importTarget, file });
        }}
      />
    </div>
  );
}
