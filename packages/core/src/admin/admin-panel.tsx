import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/utils";

export const adminPanelClass =
  "overflow-hidden rounded-xl border border-border bg-surface";

/** A panel of rows (people, teams, apps, endpoints), divided by hairlines. */
export const adminListClass =
  "divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-surface";

/** What an empty list says: what goes in it and how it gets there. */
export function AdminListEmpty({
  Icon,
  title,
  children,
}: {
  Icon?: LucideIcon;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="px-6 py-12 text-center">
      {Icon ? (
        <span className="bg-primary/10 text-primary mx-auto mb-3 grid size-10 place-items-center rounded-lg">
          <Icon className="size-4.5" />
        </span>
      ) : null}
      <p className="text-sm font-semibold">{title}</p>
      {children ? (
        <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-xs leading-5 text-pretty">
          {children}
        </p>
      ) : null}
    </div>
  );
}

export function AdminPanelHeader({
  Icon,
  title,
  description,
  children,
}: {
  Icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="border-border/70 bg-surface-sunken/60 flex items-start gap-3 border-b px-5 py-4">
      {Icon && (
        <span className="bg-primary/12 text-primary grid size-9 shrink-0 place-items-center rounded-lg">
          <Icon className="size-4.5" />
        </span>
      )}
      {children}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{title}</p>
        {description ? (
          <p className="text-muted-foreground truncate text-xs">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function AdminPanelBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("p-5", className)}>{children}</div>;
}

export function AdminPanelFooter({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "border-border/70 bg-surface-sunken/60 flex flex-wrap items-center justify-end gap-3 border-t px-5 py-3.5",
        className
      )}
    >
      {children}
    </div>
  );
}
