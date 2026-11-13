import { cn } from "../lib/utils";

/**
 * The OpenWorkspace logo: an open square with an amber dot, on the
 * brand blue in both themes. `className` sets its size (size-8 by default).
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-[28%] bg-[#355cd4] text-white",
        className
      )}
    >
      <svg viewBox="10 10 44 44" className="size-[64%]" fill="none">
        <path
          d="M38 14H22a8 8 0 0 0-8 8v20a8 8 0 0 0 8 8h20a8 8 0 0 0 8-8V30"
          stroke="currentColor"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <circle cx="48" cy="16" r="6" fill="#ffb547" />
      </svg>
    </span>
  );
}
