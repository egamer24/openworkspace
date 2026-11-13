"use client";

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { XIcon } from "lucide-react";
import * as React from "react";

import { cn } from "../../lib/utils";
import { Input } from "./input";

/**
 * An input with a list of suggestions: the input is a `combobox`, the
 * highlighted option is announced through `aria-activedescendant`, Escape
 * and a click outside close the list, and an empty result is a status
 * rather than an option.
 */
const Combobox = ComboboxPrimitive.Root;

function ComboboxInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-input"
      render={<Input />}
      className={className}
      {...props}
    />
  );
}

function ComboboxContent({
  className,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset = 0,
  anchor,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    "side" | "align" | "sideOffset" | "alignOffset" | "anchor"
  >) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="isolate z-60"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "bg-popover text-popover-foreground ring-border data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 max-h-[min(var(--available-height),24rem)] w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) overflow-y-auto overscroll-contain rounded-lg p-1 shadow-lg ring-1 duration-100",
            className
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn("scroll-py-1 outline-none data-empty:p-0", className)}
      {...props}
    />
  );
}

function ComboboxItem({ className, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground relative flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  );
}

/** Shown, and announced, only when no option matches. */
function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn(
        "text-muted-foreground px-2 py-1.5 text-xs empty:hidden",
        className
      )}
      {...props}
    />
  );
}

function ComboboxChips({ className, ...props }: ComboboxPrimitive.Chips.Props) {
  return (
    <ComboboxPrimitive.Chips
      data-slot="combobox-chips"
      className={cn("flex min-w-0 flex-wrap items-center gap-1.5", className)}
      {...props}
    />
  );
}

/** A chosen value with a button that removes it. */
function ComboboxChip({
  className,
  children,
  removeLabel,
  disabled,
  ...props
}: ComboboxPrimitive.Chip.Props & { removeLabel: string; disabled?: boolean }) {
  return (
    <ComboboxPrimitive.Chip
      data-slot="combobox-chip"
      className={cn(
        "bg-secondary text-secondary-foreground focus-visible:ring-ring data-highlighted:ring-ring inline-flex h-7 max-w-full items-center gap-1 rounded-full px-2.5 text-xs outline-none focus-visible:ring-2 data-highlighted:ring-2",
        className
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.ChipRemove
        data-slot="combobox-chip-remove"
        aria-label={removeLabel}
        disabled={disabled}
        className="text-muted-foreground hover:bg-foreground/8 hover:text-foreground focus-visible:ring-ring -mr-1 rounded-full p-0.5 outline-none focus-visible:ring-2"
      >
        <XIcon className="size-3" />
      </ComboboxPrimitive.ChipRemove>
    </ComboboxPrimitive.Chip>
  );
}

const ComboboxValue = ComboboxPrimitive.Value;
const ComboboxStatus = ComboboxPrimitive.Status;

/** The bare input for a chips field, where the field draws the box. */
function ComboboxChipsInput({
  className,
  ...props
}: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-chips-input"
      className={cn(
        "placeholder:text-muted-foreground/70 h-7 min-w-24 flex-1 bg-transparent text-sm outline-none",
        className
      )}
      {...props}
    />
  );
}

export {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxStatus,
  ComboboxValue,
};
