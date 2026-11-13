import { Check, ChevronDown, ChevronsUpDown, GitBranch } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";

import { cn } from "../lib/utils";
import { clientModules } from "../modules";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/** Apps on the way: listed as coming soon until a module brings one. */
const upcoming: { label: string; Icon: LucideIcon }[] = [
  { label: "Git", Icon: GitBranch },
];

/** The workspace's apps (each module's `app`), then the ones still to come, as menu groups. */
function AppMenuItems({ current }: { current: string }) {
  const navigate = useNavigate();
  const apps = installedApps();

  const soon = upcoming.filter(
    (app) => !apps.some((installed) => installed.label === app.label)
  );

  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Apps</DropdownMenuLabel>
        {apps.map((app) => (
          <DropdownMenuItem key={app.name} onClick={() => navigate(app.path)}>
            <app.Icon /> {app.label}
            {app.name === current ? <Check className="ml-auto" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
      {soon.length ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Coming soon</DropdownMenuLabel>
            {soon.map((app) => (
              <DropdownMenuItem key={app.label} disabled>
                <app.Icon /> {app.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </>
      ) : null}
    </>
  );
}

function installedApps() {
  return clientModules().flatMap((module) =>
    module.app ? [{ name: module.name, ...module.app }] : []
  );
}

/**
 * The current app's name, opening a menu of the workspace's apps (each
 * module's `app`) and the ones still to come. With a `logo` (the workspace's,
 * where its name has no room) the control is that logo, then the app's name
 * and a chevron, as one button; `className` adds to the button.
 */
export function AppSwitcher({
  current,
  className,
  logo,
}: {
  current: string;
  className?: string;
  logo?: ReactNode;
}) {
  const active = installedApps().find((app) => app.name === current);
  const name = active?.label ?? current;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Switch app, now ${name}`}
        className={cn(
          "focus-visible:ring-ring flex items-center transition-colors outline-none focus-visible:ring-2",
          logo
            ? [
                "group/app text-foreground h-9 shrink-0 gap-2 rounded-[10px] py-0.5 pr-2 pl-0.5 text-[15px] font-semibold tracking-[-0.015em]",
                "hover:bg-foreground/[0.05] active:bg-foreground/[0.05] aria-expanded:bg-foreground/[0.05]",
              ]
            : [
                "text-muted-foreground -mx-1.5 h-8 gap-1 rounded-md px-1.5 text-[14px] font-medium",
                "hover:bg-foreground/[0.05] hover:text-foreground aria-expanded:bg-foreground/[0.05] aria-expanded:text-foreground",
              ],
          className
        )}
      >
        {logo}
        {logo ? (
          <span className="flex items-center gap-1">
            {name}
            <ChevronDown
              aria-hidden="true"
              className="text-muted-foreground size-4 transition-transform duration-150 group-aria-expanded/app:rotate-180"
            />
          </span>
        ) : (
          <>
            {name}
            <ChevronsUpDown className="size-3.5 opacity-60" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="w-56">
        <AppMenuItems current={current} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
