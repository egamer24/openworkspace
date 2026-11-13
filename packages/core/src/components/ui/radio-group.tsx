"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "../../lib/utils";

/** One tab stop for the group; arrow keys move the choice. */
function RadioGroup<Value>({
  className,
  ...props
}: RadioGroupPrimitive.Props<Value>) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid w-full gap-2", className)}
      {...props}
    />
  );
}

function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "border-input bg-surface focus-visible:border-ring focus-visible:ring-ring/40 data-checked:border-primary data-checked:bg-primary dark:not-data-checked:bg-input/20 grid size-4 shrink-0 place-items-center rounded-full border shadow-2xs transition-[color,background-color,border-color,box-shadow] duration-150 ease-out outline-none hover:border-[color-mix(in_oklch,var(--input),var(--foreground)_20%)] focus-visible:ring-3 data-disabled:pointer-events-none data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="bg-primary-foreground size-1.5 rounded-full"
      />
    </RadioPrimitive.Root>
  );
}

/**
 * A radio as a whole card: the card is the radio, so its text is its name.
 * The chosen card is tinted from `data-checked`, and hover only tints the
 * others. Without `indicator` the card shows no dot, for cards led by an icon.
 */
function RadioCard({
  className,
  indicator = true,
  children,
  ...props
}: RadioPrimitive.Root.Props & { indicator?: boolean }) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-card"
      className={cn(
        "group/radio-card ring-border not-data-checked:hover:bg-accent/45 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:ring-primary/60 dark:data-checked:bg-primary/14 dark:data-checked:ring-primary/75 flex min-w-0 cursor-pointer items-start gap-3 rounded-lg bg-transparent px-3.5 py-3 text-left ring-1 transition-[background-color,box-shadow] duration-150 ease-out outline-none ring-inset focus-visible:ring-2 data-disabled:pointer-events-none data-disabled:opacity-60",
        className
      )}
      {...props}
    >
      {indicator ? (
        <span
          aria-hidden="true"
          data-slot="radio-card-indicator"
          className="border-input bg-surface group-data-checked/radio-card:border-primary group-data-checked/radio-card:bg-primary dark:bg-input/20 dark:group-data-checked/radio-card:bg-primary mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border shadow-2xs transition-colors duration-150"
        >
          <span className="bg-primary-foreground size-1.5 rounded-full opacity-0 group-data-checked/radio-card:opacity-100" />
        </span>
      ) : null}
      {children}
    </RadioPrimitive.Root>
  );
}

export { RadioCard, RadioGroup, RadioGroupItem };
