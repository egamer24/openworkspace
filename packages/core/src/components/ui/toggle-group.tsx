"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";
import { toggleVariants } from "./toggle";

const toggleGroupVariants = cva("group/toggle-group flex w-fit items-center", {
  variants: {
    variant: {
      default: "gap-0.5",
      segmented: "border-border bg-surface-sunken h-7 rounded-md border p-0.5",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

type ToggleGroupStyle = VariantProps<typeof toggleVariants>;

const ToggleGroupContext = React.createContext<ToggleGroupStyle>({
  variant: "default",
  size: "default",
});

/**
 * Toggles that share one value. With `required`, the pressed toggle stays
 * pressed when clicked again, so the group always has a value.
 */
function ToggleGroup({
  className,
  variant = "default",
  size: sizeProp,
  required = false,
  onValueChange,
  children,
  ...props
}: ToggleGroupPrimitive.Props &
  ToggleGroupStyle & {
    required?: boolean;
  }) {
  const size =
    sizeProp === undefined
      ? variant === "segmented"
        ? "segment"
        : "default"
      : sizeProp;

  const style = React.useMemo(() => ({ variant, size }), [variant, size]);

  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={variant}
      className={cn(toggleGroupVariants({ variant }), className)}
      onValueChange={(value, details) => {
        if (required && value.length === 0) return;
        onValueChange?.(value, details);
      }}
      {...props}
    >
      <ToggleGroupContext.Provider value={style}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  );
}

function ToggleGroupItem({
  className,
  variant,
  size,
  ...props
}: TogglePrimitive.Props & ToggleGroupStyle) {
  const context = React.useContext(ToggleGroupContext);

  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        toggleVariants({
          variant: variant ?? context.variant,
          size: size ?? context.size,
        }),
        className
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
