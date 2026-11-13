"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

/**
 * A two-state button. The pressed look comes from `data-pressed` and hover
 * only tints buttons that are not pressed, so hovering never hides the state.
 */
const toggleVariants = cva(
  "group/toggle focus-visible:border-ring focus-visible:ring-ring/35 inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow] duration-150 ease-out outline-none select-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "text-foreground/80 not-data-pressed:hover:bg-accent not-data-pressed:hover:text-accent-foreground data-pressed:bg-primary/12 data-pressed:text-primary dark:data-pressed:bg-primary/22",
        segmented:
          "text-muted-foreground not-data-pressed:hover:text-foreground focus-visible:ring-ring data-pressed:bg-surface data-pressed:text-foreground data-pressed:ring-border rounded-[4px] border-0 text-xs focus-visible:ring-2 data-pressed:shadow-xs data-pressed:ring-1",
      },
      size: {
        default: "h-9 min-w-9 px-2.5",
        sm: "h-8 min-w-8 rounded-[min(var(--radius-md),12px)] px-2 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-7 min-w-7 rounded-[min(var(--radius-md),10px)] px-1.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        segment: "h-full px-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
