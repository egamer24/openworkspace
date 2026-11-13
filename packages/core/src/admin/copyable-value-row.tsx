import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { Button } from "../components/ui/button";

export function CopyableValueRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | null;
  /** One line under the value, such as where the app asks for it. */
  hint?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex min-h-11 items-center gap-3 py-2">
      <span className="text-muted-foreground w-28 shrink-0 text-xs font-medium sm:w-36">
        {label}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="block truncate font-mono text-[11px]"
          title={value ?? undefined}
        >
          {value ?? "—"}
        </span>
        {hint ? (
          <span className="text-muted-foreground block text-[11px]">
            {hint}
          </span>
        ) : null}
      </span>
      {value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check /> : <Copy />}
          <span className="sr-only">Copy {label}</span>
        </Button>
      ) : null}
    </div>
  );
}
