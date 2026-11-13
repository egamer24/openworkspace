import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "lucide-react";

import { cn } from "../../lib/utils";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer border-input bg-surface text-primary-foreground focus-visible:border-ring focus-visible:ring-ring/40 data-checked:border-primary data-checked:bg-primary data-indeterminate:border-primary data-indeterminate:bg-primary dark:not-data-checked:not-data-indeterminate:bg-input/20 grid size-4.5 shrink-0 place-items-center rounded-[6px] border shadow-2xs transition-[color,background-color,border-color,box-shadow] duration-150 ease-out outline-none hover:border-[color-mix(in_oklch,var(--input),var(--foreground)_20%)] focus-visible:ring-3 data-disabled:pointer-events-none data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        render={(indicatorProps, state) => (
          <span {...indicatorProps}>
            {state.indeterminate ? (
              <MinusIcon className="size-3.5" strokeWidth={3} />
            ) : (
              <CheckIcon className="size-3.5" strokeWidth={3} />
            )}
          </span>
        )}
      />
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
