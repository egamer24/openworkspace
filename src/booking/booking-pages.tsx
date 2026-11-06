import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarCheck, ChevronLeft, ChevronRight, Clock, LoaderCircle, MapPin } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Route, Routes, useParams } from "react-router";
import {
  formatSlotDateTime,
  formatSlotTime,
  groupSlotsByDay,
} from "../../shared/booking";
import { AuthHeading, AuthShell } from "@/auth/auth-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, responseJson } from "@/lib/api";

const DAY = 86_400_000;
const detectedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const timeZones = Intl.supportedValuesOf("timeZone");

function Shell({ host, children }: { host?: string; children: ReactNode }) {
  return (
    <AuthShell Icon={CalendarCheck} title={host ?? "Booking"} subtitle={host ? "Booking page" : undefined} width="max-w-2xl">
      {children}
    </AuthShell>
  );
}

function Loading() {
  return <div className="grid place-items-center py-10"><LoaderCircle className="animate-spin text-muted-foreground" /></div>;
}

function Unavailable({ message = "This booking page does not exist or is not available." }: { message?: string }) {
  return <Shell><AuthHeading title="Not available" description={message} /></Shell>;
}

function TimeZoneSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      Time zone
      <select
        className="h-8 max-w-56 rounded-md border bg-transparent px-2 text-xs text-foreground"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {(timeZones.includes(value) ? timeZones : [value, ...timeZones]).map((zone) => (
          <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>
        ))}
      </select>
    </label>
  );
}

/** A week of free slots at a time, shown in the guest's time zone. */
function SlotPicker({
  queryKey,
  maxDaysAhead,
  timeZone,
  fetchSlots,
  onPick,
}: {
  queryKey: unknown[];
  maxDaysAhead: number;
  timeZone: string;
  fetchSlots: (from: number, to: number) => Promise<number[]>;
  onPick: (slot: number) => void;
}) {
  const [now] = useState(() => Date.now());
  const [week, setWeek] = useState(0);
  const from = now + week * 7 * DAY;
  const slots = useQuery({
    queryKey: [...queryKey, from],
    queryFn: () => fetchSlots(from, from + 7 * DAY),
    placeholderData: (previous) => previous,
  });
  const days = groupSlotsByDay(slots.data ?? [], timeZone);
  const dayLabel = (slot: number) => new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(slot);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="icon-sm" aria-label="Previous week" disabled={week === 0} onClick={() => setWeek(week - 1)}>
          <ChevronLeft />
        </Button>
        <span className="text-sm font-medium">
          {dayLabel(from)} – {dayLabel(from + 6 * DAY)}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next week"
          disabled={(week + 1) * 7 >= maxDaysAhead}
          onClick={() => setWeek(week + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
      {slots.isLoading ? <Loading /> : slots.isError ? (
        <p className="text-sm text-destructive">{slots.error.message}</p>
      ) : days.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No free times this week.</p>
      ) : (
        <div className="space-y-4" aria-busy={slots.isFetching}>
          {days.map((day) => (
            <div key={day.date}>
              <p className="mb-2 text-xs font-semibold text-muted-foreground">{dayLabel(day.slots[0]!)}</p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {day.slots.map((slot) => (
                  <Button key={slot} variant="outline" size="sm" onClick={() => onPick(slot)}>
                    {formatSlotTime(slot, timeZone)}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HostPage() {
  const { handle = "" } = useParams();
  const page = useQuery({
    queryKey: ["booking", handle],
    queryFn: async () => responseJson(await api.api.public.booking[":handle"].$get({ param: { handle } })),
    retry: false,
  });
  if (page.isLoading) return <Shell><Loading /></Shell>;
  if (!page.data) return <Unavailable />;
  return (
    <Shell host={page.data.host.name}>
      <AuthHeading title={`Book time with ${page.data.host.name}`} />
      {page.data.types.length === 0 ? (
        <p className="pt-6 text-sm text-muted-foreground">There is nothing to book right now.</p>
      ) : (
        <ul className="divide-y divide-border">
          {page.data.types.map((type) => (
            <li key={type.slug}>
              <Link className="block py-4 hover:text-primary" to={`/book/${handle}/${type.slug}`}>
                <span className="block font-semibold">{type.name}</span>
                <span className="text-xs text-muted-foreground">{type.durationMinutes} minutes</span>
                {type.description && <span className="mt-1 block text-sm text-muted-foreground">{type.description}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

declare global {
  interface Window {
    turnstile?: {
      render: (element: HTMLElement, options: { sitekey: string; callback: (token: string) => void }) => string;
      reset: (widgetId: string) => void;
    };
  }
}

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Cloudflare Turnstile, only when the deployment configured a site key. */
function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (token: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    const render = () => {
      if (!cancelled && container.current && window.turnstile) {
        window.turnstile.render(container.current, { sitekey: siteKey, callback: onToken });
      }
    };
    if (window.turnstile) render();
    else {
      let script = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT}"]`);
      if (!script) {
        script = document.createElement("script");
        script.src = TURNSTILE_SCRIPT;
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", render);
    }
    return () => { cancelled = true; };
  }, [siteKey, onToken]);
  return <div ref={container} />;
}

function Summary({ type, start, timeZone }: {
  type: { name: string; durationMinutes: number; location: string };
  start?: number;
  timeZone: string;
}) {
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p className="flex items-center gap-2"><Clock className="size-4" />{type.durationMinutes} minutes</p>
      {type.location && <p className="flex items-center gap-2"><MapPin className="size-4" />{type.location}</p>}
      {start !== undefined && (
        <p className="flex items-center gap-2 font-medium text-foreground">
          <CalendarCheck className="size-4" />{formatSlotDateTime(start, timeZone)}
        </p>
      )}
    </div>
  );
}

function TypePage() {
  const { handle = "", slug = "" } = useParams();
  const [timeZone, setTimeZone] = useState(detectedTimeZone);
  const [slot, setSlot] = useState<number | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const page = useQuery({
    queryKey: ["booking", handle, slug],
    queryFn: async () => responseJson(await api.api.public.booking[":handle"][":slug"].$get({ param: { handle, slug } })),
    retry: false,
  });
  const book = useMutation({
    mutationFn: async (form: FormData) => responseJson(await api.api.public.booking[":handle"][":slug"].bookings.$post({
      param: { handle, slug },
      json: {
        start: slot!,
        name: String(form.get("name") ?? ""),
        email: String(form.get("email") ?? ""),
        notes: String(form.get("notes") ?? ""),
        website: String(form.get("website") ?? ""),
        timeZone,
        turnstileToken,
      },
    })),
  });
  if (page.isLoading) return <Shell><Loading /></Shell>;
  if (!page.data) return <Unavailable />;
  const { type, host, turnstileSiteKey } = page.data;

  if (book.data) {
    return (
      <Shell host={host.name}>
        <AuthHeading eyebrow="Confirmed" title={`${type.name} with ${host.name}`} />
        <div className="space-y-4 pt-6">
          <Summary type={type} start={book.data.booking.startsAt} timeZone={timeZone} />
          <p className="text-sm text-muted-foreground">
            {book.data.emailSent
              ? "A confirmation with a calendar invite is on its way to your inbox."
              : "Keep the link below to change or cancel your booking."}
          </p>
          <Link className={buttonVariants({ variant: "outline" })} to={`/book/manage/${book.data.manageToken}`}>
            Cancel or reschedule
          </Link>
        </div>
      </Shell>
    );
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    book.mutate(new FormData(event.currentTarget));
  }

  return (
    <Shell host={host.name}>
      <AuthHeading title={type.name} description={type.description || undefined} />
      <div className="space-y-6 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Summary type={type} start={slot ?? undefined} timeZone={timeZone} />
          <TimeZoneSelect value={timeZone} onChange={setTimeZone} />
        </div>
        {slot === null ? (
          <SlotPicker
            queryKey={["booking", handle, slug, "slots"]}
            maxDaysAhead={type.maxDaysAhead}
            timeZone={timeZone}
            onPick={setSlot}
            fetchSlots={async (from, to) => (await responseJson(
              await api.api.public.booking[":handle"][":slug"].slots.$get({
                param: { handle, slug },
                query: { from: String(from), to: String(to) },
              }),
            )).slots}
          />
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-2">
              <Label htmlFor="booking-name">Name</Label>
              <Input id="booking-name" name="name" required maxLength={120} autoComplete="name" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="booking-email">Email</Label>
              <Input id="booking-email" name="email" type="email" required maxLength={254} autoComplete="email" />
            </div>
            {type.collectNotes && (
              <div className="space-y-2">
                <Label htmlFor="booking-notes">Notes (optional)</Label>
                <Textarea id="booking-notes" name="notes" maxLength={2_000} />
              </div>
            )}
            {/* Honeypot: invisible to people, tempting to form-filling bots. */}
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              className="absolute -left-[9999px] h-0 w-0 opacity-0"
            />
            {turnstileSiteKey && <Turnstile siteKey={turnstileSiteKey} onToken={setTurnstileToken} />}
            {book.error && <p role="alert" className="text-sm text-destructive">{book.error.message}</p>}
            <div className="flex justify-between gap-2">
              <Button type="button" variant="ghost" onClick={() => { setSlot(null); book.reset(); }}>Back</Button>
              <Button type="submit" disabled={book.isPending || Boolean(turnstileSiteKey && !turnstileToken)}>
                {book.isPending && <LoaderCircle className="animate-spin" />}
                Confirm booking
              </Button>
            </div>
          </form>
        )}
      </div>
    </Shell>
  );
}

function ManagePage() {
  const { token = "" } = useParams();
  const [currentToken, setCurrentToken] = useState(token);
  const [rescheduling, setRescheduling] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const page = useQuery({
    queryKey: ["booking", "manage", currentToken],
    queryFn: async () => responseJson(await api.api.public.booking.manage[":token"].$get({ param: { token: currentToken } })),
    retry: false,
  });
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: async () => responseJson(await api.api.public.booking.manage[":token"].cancel.$post({ param: { token: currentToken } })),
    onSuccess: () => setDone("Your booking has been cancelled."),
  });
  const reschedule = useMutation({
    mutationFn: async (start: number) => responseJson(await api.api.public.booking.manage[":token"].reschedule.$post({
      param: { token: currentToken },
      json: { start },
    })),
    onSuccess: (result) => {
      setRescheduling(false);
      setCurrentToken(result.manageToken);
      window.history.replaceState(null, "", `/book/manage/${result.manageToken}`);
    },
  });
  if (done) return <Shell><AuthHeading title="Done" description={done} /></Shell>;
  if (page.isLoading) return <Shell><Loading /></Shell>;
  if (!page.data) return <Unavailable message="This link is invalid or has expired." />;
  const { booking, type, host } = page.data;
  const zone = timeZone ?? booking.guestTimeZone;
  const error = cancel.error ?? reschedule.error;
  return (
    <Shell host={host.name}>
      <AuthHeading eyebrow={`Booking for ${booking.guestName}`} title={`${type.name} with ${host.name}`} />
      <div className="space-y-6 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Summary type={type} start={booking.startsAt} timeZone={zone} />
          <TimeZoneSelect value={zone} onChange={setTimeZone} />
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
        {rescheduling ? (
          <>
            <SlotPicker
              queryKey={["booking", "manage", currentToken, "slots"]}
              maxDaysAhead={type.maxDaysAhead}
              timeZone={zone}
              onPick={(slot) => reschedule.mutate(slot)}
              fetchSlots={async (from, to) => (await responseJson(
                await api.api.public.booking.manage[":token"].slots.$get({
                  param: { token: currentToken },
                  query: { from: String(from), to: String(to) },
                }),
              )).slots}
            />
            <Button variant="ghost" onClick={() => setRescheduling(false)}>Back</Button>
          </>
        ) : (
          <div className="flex flex-wrap gap-2">
            {page.data.canReschedule && (
              <Button variant="outline" onClick={() => setRescheduling(true)}>Reschedule</Button>
            )}
            <Button variant="destructive" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              {cancel.isPending && <LoaderCircle className="animate-spin" />}
              Cancel booking
            </Button>
          </div>
        )}
      </div>
    </Shell>
  );
}

/** Public, signed-out pages under /book. */
export function BookingPages() {
  return (
    <Routes>
      <Route path="manage/:token" element={<ManagePage />} />
      <Route path=":handle" element={<HostPage />} />
      <Route path=":handle/:slug" element={<TypePage />} />
      <Route path="*" element={<Unavailable />} />
    </Routes>
  );
}
