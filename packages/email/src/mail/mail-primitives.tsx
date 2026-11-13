import { cn, initials } from "@open-workspace/core/ui";
import type { CSSProperties } from "react";

/** Stable hue per name so the same mailbox or person keeps the same tint. */
function hueFor(value: string) {
  let hash = 0;

  // oxlint-disable-next-line unicorn/prefer-math-trunc -- | 0 wraps the hash to 32 bits, which Math.trunc does not
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) | 0;

  return Math.abs(hash) % 360;
}

function monogramStyle(
  name: string
): CSSProperties & Record<"--monogram-hue", number> {
  return { "--monogram-hue": hueFor(name) };
}

export function Monogram({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      style={monogramStyle(name)}
      className={cn(
        "monogram grid shrink-0 place-items-center font-semibold",
        className
      )}
    >
      {initials(name)}
    </span>
  );
}

export function CountPill({
  count,
  label,
  strong = false,
  className,
}: {
  count: number;
  label: string;
  strong?: boolean;
  className?: string;
}) {
  if (count <= 0) return null;

  return (
    <span
      aria-label={label}
      className={cn(
        "ml-auto min-w-5 shrink-0 rounded-full px-1.5 py-0.5 text-center text-[10.5px] leading-[14px] font-semibold tabular-nums",
        strong ? "bg-primary text-primary-foreground" : "text-muted-foreground",
        className
      )}
    >
      {count > 999 ? "999+" : count}
    </span>
  );
}
