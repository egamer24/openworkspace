import { Check, Clipboard } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function CopyField({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      toast.error(`${label} could not be copied`);
    }
  }
  return (
    <div className={cn("flex gap-2", className)}>
      <Input
        readOnly
        value={value}
        aria-label={label}
        className="h-8 font-mono text-xs md:text-xs"
        onFocus={(event) => event.target.select()}
      />
      <Button type="button" variant="outline" size="icon-sm" onClick={() => void copy()}>
        {copied ? <Check /> : <Clipboard />}
        <span className="sr-only">Copy {label}</span>
      </Button>
    </div>
  );
}
