import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@open-workspace/core/ui";
import type { ReactNode } from "react";

export function ToolbarTooltip({
  label,
  side = "top",
  sideOffset = 7,
  children,
}: {
  label: string;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={sideOffset}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
