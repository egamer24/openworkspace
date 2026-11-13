import { cn } from "../../lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-pulse rounded-lg bg-[color-mix(in_oklab,var(--muted),var(--foreground)_4%)]",
        className
      )}
      {...props}
    />
  );
}

export { Skeleton };
