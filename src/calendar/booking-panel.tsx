import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { formatSlotDateTime } from "../../shared/booking";
import { weekdayCodes, type WeekdayCode } from "../../shared/calendar";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, responseJson, type SuccessfulResponse } from "@/lib/api";
import type { CalendarItem } from "./types";

type BookingType = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.calendar.booking.$get>>
>["types"][number];

const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const timeZones = Intl.supportedValuesOf("timeZone");
const dayLabels: Record<WeekdayCode, string> = {
  MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun",
};
const selectClass = "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm";

const toTime = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
/** `00:00` as an end time means midnight at the end of the day. */
const fromTime = (value: string, end = false) => {
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  const total = hours * 60 + minutes;
  return end && total === 0 ? 1_440 : total;
};

/** Host side of the booking pages: types, public link and upcoming bookings. */
export function BookingPanel({
  open,
  onOpenChange,
  calendars,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  calendars: CalendarItem[];
}) {
  const client = useQueryClient();
  const [editing, setEditing] = useState<BookingType | "new" | null>(null);
  const state = useQuery({
    queryKey: ["calendar", "booking"],
    queryFn: async () => responseJson(await api.api.calendar.booking.$get({ query: { timeZone: browserTimeZone } })),
    enabled: open,
  });
  const bookings = useQuery({
    queryKey: ["calendar", "booking", "bookings"],
    queryFn: async () => (await responseJson(await api.api.calendar.booking.bookings.$get())).bookings,
    enabled: open,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["calendar"] });
  const onError = (error: Error) => toast.error(error.message);
  const toggle = useMutation({
    mutationFn: async (input: { id: string; enabled: boolean }) => responseJson(
      await api.api.calendar.booking.types[":typeId"].$patch({ param: { typeId: input.id }, json: { enabled: input.enabled } }),
    ),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: async (id: string) => responseJson(
      await api.api.calendar.booking.types[":typeId"].$delete({ param: { typeId: id } }),
    ),
    onSuccess: refresh,
    onError,
  });
  const cancel = useMutation({
    mutationFn: async (id: string) => responseJson(
      await api.api.calendar.booking.bookings[":bookingId"].cancel.$post({ param: { bookingId: id } }),
    ),
    onSuccess: async (result) => {
      toast.success(result.emailSent ? "Booking cancelled, guest notified" : "Booking cancelled");
      await refresh();
    },
    onError,
  });

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.message("Booking link", { description: url });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Booking pages</DialogTitle></DialogHeader>
        {state.isLoading || !state.data ? (
          <div className="grid place-items-center py-8"><LoaderCircle className="animate-spin text-muted-foreground" /></div>
        ) : editing ? (
          <BookingTypeForm
            type={editing === "new" ? null : editing}
            calendars={calendars}
            onDone={async () => { setEditing(null); await refresh(); }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div className="space-y-6">
            <div className="flex items-center gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-sm ring-1 ring-border">
              <span className="min-w-0 flex-1 truncate">{state.data.url}</span>
              <Button variant="ghost" size="icon-xs" aria-label="Copy booking link" onClick={() => copy(state.data.url)}>
                <Copy />
              </Button>
            </div>
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Booking types</h3>
                <Button size="sm" variant="outline" onClick={() => setEditing("new")}><Plus /> New type</Button>
              </div>
              <ul className="divide-y divide-border">
                {state.data.types.map((type) => (
                  <li key={type.id} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{type.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        /{type.slug} · {type.durationMinutes} min{type.senderMailboxId ? "" : " · no confirmation email"}
                      </p>
                    </div>
                    <Switch
                      aria-label={`Enable ${type.name}`}
                      checked={type.enabled}
                      onCheckedChange={(enabled) => toggle.mutate({ id: type.id, enabled })}
                    />
                    <Button variant="ghost" size="icon-xs" aria-label={`Edit ${type.name}`} onClick={() => setEditing(type)}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon-xs" aria-label={`Delete ${type.name}`} onClick={() => remove.mutate(type.id)}>
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
            <section className="space-y-2">
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Upcoming bookings</h3>
              {!bookings.data?.length ? (
                <p className="text-sm text-muted-foreground">No upcoming bookings.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {bookings.data.map((booking) => (
                    <li key={booking.id} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{booking.guestName} · {booking.bookingTypeName}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {formatSlotDateTime(booking.startsAt, browserTimeZone)} · {booking.guestEmail}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={cancel.isPending}
                        onClick={() => cancel.mutate(booking.id)}
                      >
                        Cancel
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NumberField({ id, label, value, onChange, min = 0, max }: {
  id: string;
  label: string;
  value: number | "";
  onChange: (value: number | "") => void;
  min?: number;
  max?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
      />
    </div>
  );
}

function BookingTypeForm({
  type,
  calendars,
  onDone,
  onCancel,
}: {
  type: BookingType | null;
  calendars: CalendarItem[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const mailboxes = useQuery({
    queryKey: ["mailboxes"],
    queryFn: async () => (await responseJson(await api.api.mail.mailboxes.$get())).mailboxes,
  });
  const [form, setForm] = useState(() => ({
    name: type?.name ?? "",
    slug: type?.slug ?? "",
    description: type?.description ?? "",
    location: type?.location ?? "",
    durationMinutes: type?.durationMinutes ?? 30,
    slotIntervalMinutes: type?.slotIntervalMinutes ?? 30,
    timeZone: type?.timeZone ?? browserTimeZone,
    bufferBeforeMinutes: type?.bufferBeforeMinutes ?? 0,
    bufferAfterMinutes: type?.bufferAfterMinutes ?? 0,
    minimumNoticeMinutes: type?.minimumNoticeMinutes ?? 240,
    maxDaysAhead: type?.maxDaysAhead ?? 60,
    dailyCap: (type?.dailyCap ?? "") as number | "",
    collectNotes: type?.collectNotes ?? true,
    calendarId: type?.calendarId ?? null,
    senderMailboxId: type?.senderMailboxId ?? null,
    enabled: type?.enabled ?? false,
    weeklyHours: type?.weeklyHours ?? weekdayCodes.slice(0, 5).map((day) => ({ day, start: 540, end: 1_020 })),
    dateOverrides: type?.dateOverrides ?? [],
  }));
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const save = useMutation({
    mutationFn: async () => {
      const json = {
        ...form,
        durationMinutes: Number(form.durationMinutes),
        dailyCap: form.dailyCap === "" ? null : form.dailyCap,
      };
      return type
        ? responseJson(await api.api.calendar.booking.types[":typeId"].$patch({ param: { typeId: type.id }, json }))
        : responseJson(await api.api.calendar.booking.types.$post({ json }));
    },
    onSuccess: onDone,
    onError: (error) => toast.error(error.message),
  });

  // The form edits one range per weekday; the API also accepts several.
  const dayRange = (day: WeekdayCode) => form.weeklyHours.find((range) => range.day === day);
  const setDay = (day: WeekdayCode, range: { start: number; end: number } | null) => set(
    "weeklyHours",
    [
      ...form.weeklyHours.filter((item) => item.day !== day),
      ...(range ? [{ day, ...range }] : []),
    ].sort((a, b) => weekdayCodes.indexOf(a.day) - weekdayCodes.indexOf(b.day)),
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bt-name">Name</Label>
          <Input id="bt-name" required maxLength={120} value={form.name} onChange={(event) => set("name", event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bt-slug">Link slug</Label>
          <Input
            id="bt-slug"
            required
            pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?"
            value={form.slug}
            onChange={(event) => set("slug", event.target.value.toLowerCase())}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="bt-description">Description</Label>
          <Textarea id="bt-description" maxLength={2_000} value={form.description} onChange={(event) => set("description", event.target.value)} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="bt-location">Location or video link</Label>
          <Input id="bt-location" maxLength={500} value={form.location} onChange={(event) => set("location", event.target.value)} />
        </div>
        <NumberField id="bt-duration" label="Duration (minutes)" min={5} max={720} value={form.durationMinutes}
          onChange={(value) => set("durationMinutes", Number(value) || 0)} />
        <NumberField id="bt-interval" label="Start times every (minutes)" min={5} max={720} value={form.slotIntervalMinutes}
          onChange={(value) => set("slotIntervalMinutes", Number(value) || 0)} />
        <NumberField id="bt-before" label="Buffer before (minutes)" max={720} value={form.bufferBeforeMinutes}
          onChange={(value) => set("bufferBeforeMinutes", Number(value) || 0)} />
        <NumberField id="bt-after" label="Buffer after (minutes)" max={720} value={form.bufferAfterMinutes}
          onChange={(value) => set("bufferAfterMinutes", Number(value) || 0)} />
        <NumberField id="bt-notice" label="Minimum notice (minutes)" max={43_200} value={form.minimumNoticeMinutes}
          onChange={(value) => set("minimumNoticeMinutes", Number(value) || 0)} />
        <NumberField id="bt-horizon" label="Bookable days ahead" min={1} max={365} value={form.maxDaysAhead}
          onChange={(value) => set("maxDaysAhead", Number(value) || 1)} />
        <NumberField id="bt-cap" label="Bookings per day (empty: no limit)" min={1} max={100} value={form.dailyCap}
          onChange={(value) => set("dailyCap", value)} />
        <div className="space-y-1.5">
          <Label htmlFor="bt-zone">Time zone of the hours below</Label>
          <select id="bt-zone" className={selectClass} value={form.timeZone} onChange={(event) => set("timeZone", event.target.value)}>
            {(timeZones.includes(form.timeZone) ? timeZones : [form.timeZone, ...timeZones])
              .map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bt-calendar">Add bookings to</Label>
          <select id="bt-calendar" className={selectClass} value={form.calendarId ?? ""}
            onChange={(event) => set("calendarId", event.target.value || null)}>
            <option value="">First calendar</option>
            {calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bt-mailbox">Send confirmations from</Label>
          <select id="bt-mailbox" className={selectClass} value={form.senderMailboxId ?? ""}
            onChange={(event) => set("senderMailboxId", event.target.value || null)}>
            <option value="">Do not email guests</option>
            {(mailboxes.data ?? []).filter((mailbox) => mailbox.canSend).map((mailbox) => (
              <option key={mailbox.id} value={mailbox.id}>{mailbox.address}</option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Weekly hours</legend>
        {weekdayCodes.map((day) => {
          const range = dayRange(day);
          return (
            <div key={day} className="flex items-center gap-3">
              <Switch
                aria-label={`Available on ${dayLabels[day]}`}
                checked={Boolean(range)}
                onCheckedChange={(checked) => setDay(day, checked ? { start: 540, end: 1_020 } : null)}
              />
              <span className="w-10 text-sm">{dayLabels[day]}</span>
              {range ? (
                <>
                  <Input className="w-28" type="time" aria-label={`${dayLabels[day]} from`} value={toTime(range.start)}
                    onChange={(event) => setDay(day, { ...range, start: fromTime(event.target.value) })} />
                  <span className="text-muted-foreground">–</span>
                  <Input className="w-28" type="time" aria-label={`${dayLabels[day]} until`} value={toTime(range.end)}
                    onChange={(event) => setDay(day, { ...range, end: fromTime(event.target.value, true) })} />
                </>
              ) : <span className="text-sm text-muted-foreground">Unavailable</span>}
            </div>
          );
        })}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Date overrides</legend>
        {form.dateOverrides.map((override, index) => {
          const range = override.ranges[0];
          const update = (next: typeof override) =>
            set("dateOverrides", form.dateOverrides.map((item, position) => position === index ? next : item));
          return (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Input className="w-40" type="date" aria-label="Date" required value={override.date}
                onChange={(event) => update({ ...override, date: event.target.value })} />
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={Boolean(range)}
                  onCheckedChange={(checked) => update({ ...override, ranges: checked ? [{ start: 540, end: 1_020 }] : [] })} />
                {range ? "Custom hours" : "Unavailable all day"}
              </label>
              {range && (
                <>
                  <Input className="w-28" type="time" aria-label="From" value={toTime(range.start)}
                    onChange={(event) => update({ ...override, ranges: [{ ...range, start: fromTime(event.target.value) }] })} />
                  <Input className="w-28" type="time" aria-label="Until" value={toTime(range.end)}
                    onChange={(event) => update({ ...override, ranges: [{ ...range, end: fromTime(event.target.value, true) }] })} />
                </>
              )}
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Remove override"
                onClick={() => set("dateOverrides", form.dateOverrides.filter((_, position) => position !== index))}>
                <X />
              </Button>
            </div>
          );
        })}
        <Button type="button" variant="outline" size="sm"
          onClick={() => set("dateOverrides", [...form.dateOverrides, { date: new Date().toISOString().slice(0, 10), ranges: [] }])}>
          <Plus /> Add date
        </Button>
      </fieldset>

      <div className="space-y-2">
        <label className="flex items-center justify-between gap-4 text-sm">
          Ask guests for notes (name and email are always required)
          <Switch checked={form.collectNotes} onCheckedChange={(checked) => set("collectNotes", checked)} />
        </label>
        <label className="flex items-center justify-between gap-4 text-sm">
          Enabled
          <Switch checked={form.enabled} onCheckedChange={(checked) => set("enabled", checked)} />
        </label>
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>Back</Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <LoaderCircle className="animate-spin" />}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
