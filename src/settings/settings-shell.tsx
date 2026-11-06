import {
  ArrowLeft,
  Bell,
  Inbox,
  KeyRound,
  LoaderCircle,
  Menu,
  Palette,
  ShieldCheck,
  UserRound,
  VenetianMask,
  type LucideIcon,
} from "lucide-react";
import { Suspense, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type SettingsSection =
  | "profile"
  | "appearance"
  | "notifications"
  | "throwaway"
  | "sessions"
  | "mcp";

const settingsSections: Array<{
  id: SettingsSection;
  label: string;
  description: string;
  Icon: LucideIcon;
  path: string;
}> = [
  {
    id: "profile",
    label: "Profile",
    description: "Your photo and account details.",
    Icon: UserRound,
    path: "/settings/profile",
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Light, dark, or match the system.",
    Icon: Palette,
    path: "/settings/appearance",
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "New mail alerts for this device and your mailboxes.",
    Icon: Bell,
    path: "/settings/notifications",
  },
  {
    id: "throwaway",
    label: "Throwaway addresses",
    description: "Random receive-only addresses you can turn off.",
    Icon: VenetianMask,
    path: "/settings/throwaway",
  },
  {
    id: "sessions",
    label: "Sessions",
    description: "Active sign-ins and locations.",
    Icon: ShieldCheck,
    path: "/settings/sessions",
  },
  {
    id: "mcp",
    label: "MCP",
    description: "Connect AI clients with a personal account token.",
    Icon: KeyRound,
    path: "/settings/mcp",
  },
];

function sectionFromPath(pathname: string): SettingsSection {
  if (pathname.startsWith("/settings/mcp")) return "mcp";
  if (pathname.startsWith("/settings/notifications")) return "notifications";
  if (pathname.startsWith("/settings/throwaway")) return "throwaway";
  if (pathname.startsWith("/settings/sessions")) return "sessions";
  if (pathname.startsWith("/settings/appearance")) return "appearance";
  return "profile";
}

function SettingsNavigation({
  value,
  onNavigate,
}: {
  value: SettingsSection;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex flex-1 flex-col gap-0.5 p-3">
      {settingsSections.map(({ id, label, Icon, path }) => (
        <NavLink
          key={id}
          to={path}
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-2.5 rounded-md px-3 py-2 text-[0.8125rem] font-medium transition-colors",
            value === id
              ? "bg-primary/14 text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <Icon className="size-4 shrink-0" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function MobileSettingsMenu({ value }: { value: SettingsSection }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={(
          <Button className="md:hidden" variant="ghost" size="icon-sm" />
        )}
      >
        <Menu />
        <span className="sr-only">Open settings navigation</span>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 gap-0 p-0" showCloseButton>
        <SheetHeader className="border-b border-border/70 pr-12">
          <SheetTitle className="font-semibold tracking-[-0.01em]">OpenWorkspace</SheetTitle>
          <SheetDescription>Settings</SheetDescription>
        </SheetHeader>
        <SettingsNavigation value={value} onNavigate={() => setOpen(false)} />
        <SheetFooter className="border-t border-border/70">
          <Button
            className="w-full justify-start"
            variant="ghost"
            onClick={() => {
              setOpen(false);
              navigate("/");
            }}
          >
            <ArrowLeft /> Back to mail
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function SettingsShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const section = sectionFromPath(location.pathname);
  const copy = settingsSections.find((item) => item.id === section)!;

  return (
    <main className="flex h-dvh min-h-0 bg-background">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4">
          <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
            <Inbox className="size-4.5" strokeWidth={2.25} />
          </span>
          <div>
            <p className="text-[0.875rem] leading-tight font-semibold tracking-[-0.01em]">
              OpenWorkspace
            </p>
            <p className="text-[11px] leading-tight text-muted-foreground">Settings</p>
          </div>
        </div>
        <SettingsNavigation value={section} />
        <div className="mt-auto border-t border-border/70 p-3">
          <Button className="w-full justify-start" variant="ghost" onClick={() => navigate("/")}>
            <ArrowLeft /> Back to mail
          </Button>
        </div>
      </aside>

      <section className="paper-grain flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 sm:px-6 lg:px-8">
          <MobileSettingsMenu value={section} />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-[-0.02em]">{copy.label}</h1>
            <p className="hidden truncate text-xs text-muted-foreground sm:block">
              {copy.description}
            </p>
          </div>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
            <Suspense
              fallback={(
                <div className="grid min-h-48 place-items-center">
                  <LoaderCircle className="animate-spin text-muted-foreground" />
                </div>
              )}
            >
              <Outlet />
            </Suspense>
          </div>
        </ScrollArea>
      </section>
    </main>
  );
}
