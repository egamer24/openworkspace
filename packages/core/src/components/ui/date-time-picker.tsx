import { CalendarDays, X } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Calendar } from "./calendar";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

const pad = (value: number) => String(value).padStart(2, "0");

/** "HH:mm" in local time, as `<input type="time">` takes it. */
function timeOf(date: Date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function withTime(date: Date, time: string) {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  const next = new Date(date);

  next.setHours(hours, minutes, 0, 0);

  return next;
}

/**
 * A date from a Calendar in a Popover, plus a time, in local time. Empty
 * shows `placeholder`, never a made-up date; a set value can be cleared.
 * A newly picked day keeps the time already chosen, else `defaultTime`.
 */
export function DateTimePicker({
  id,
  value,
  onChange,
  placeholder = "Pick a date",
  defaultTime = "09:00",
  disabled,
  className,
}: {
  id?: string;
  value: Date | null;
  onChange: (value: Date | null) => void;
  placeholder?: string;
  defaultTime?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id={id}
              type="button"
              variant="outline"
              disabled={disabled}
              className={cn(
                "min-w-0 flex-1 justify-start font-normal",
                !value && "text-muted-foreground"
              )}
            />
          }
        >
          <CalendarDays />
          <span className="truncate">
            {value
              ? value.toLocaleDateString(undefined, { dateStyle: "medium" })
              : placeholder}
          </span>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={value ?? undefined}
            defaultMonth={value ?? undefined}
            autoFocus
            onSelect={(day) => {
              if (!day) return;
              onChange(withTime(day, value ? timeOf(value) : defaultTime));
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      <Input
        type="time"
        aria-label="Time"
        className="w-32 shrink-0"
        disabled={disabled || !value}
        value={value ? timeOf(value) : ""}
        onChange={(event) => {
          if (value && event.target.value) {
            onChange(withTime(value, event.target.value));
          }
        }}
      />
      {value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Clear"
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          <X />
        </Button>
      ) : null}
    </div>
  );
}
