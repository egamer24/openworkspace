import {
  CalendarDays,
  Check,
  ChevronsUpDown,
  HardDrive,
  Inbox,
  Mail,
  PenLine,
  Search,
  Settings2,
  Settings,
  UserRound,
} from "lucide-react";
import { useNavigate } from "react-router";
import { useAuth } from "@/auth/auth-context";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useDriveStatus } from "@/drive/drive-status";
import { cn } from "@/lib/utils";
import type { Mailbox } from "./types";

export function MailHeader({
  mailbox,
  mailboxes,
  search,
  searchPlaceholder,
  showSearch,
  onSearchChange,
  onMailboxChange,
  onCompose,
  onAdministration,
}: {
  mailbox?: Mailbox;
  mailboxes: Mailbox[];
  search: string;
  searchPlaceholder: string;
  showSearch: boolean;
  onSearchChange: (value: string) => void;
  onMailboxChange: (mailboxId: string) => void;
  onCompose: () => void;
  onAdministration: () => void;
}) {
  const auth = useAuth();
  const navigate = useNavigate();
  const drive = useDriveStatus();
  let otherMailboxUnreadCount = 0;
  for (const item of mailboxes) {
    if (item.id !== mailbox?.id) {
      otherMailboxUnreadCount += item.unreadCount;
    }
  }
  const otherMailboxUnreadLabel = otherMailboxUnreadCount > 99
    ? "99+"
    : String(otherMailboxUnreadCount);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 sm:px-5">
      <div className="flex shrink-0 items-center gap-2.5 lg:mr-1">
        <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
          <Inbox className="size-4.5" strokeWidth={2.25} />
        </span>
        <span className="hidden text-sm leading-none font-semibold tracking-[-0.01em] xl:inline">
          OpenWorkspace
        </span>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-2">
        {showSearch && (
          <label className="relative hidden w-48 xl:block 2xl:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-9 bg-surface-sunken pr-3 pl-9"
              placeholder={searchPlaceholder}
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </label>
        )}

        {auth.modules.calendar && (
          <Button variant="ghost" size="icon" aria-label="Calendar" onClick={() => navigate("/calendar")}>
            <CalendarDays />
          </Button>
        )}

        <Button className="hidden lg:inline-flex" disabled={!mailbox?.canSend} onClick={onCompose}>
          <PenLine /> Compose
        </Button>
        <Button className="lg:hidden" variant="outline" size="icon" disabled={!mailbox?.canSend} onClick={onCompose}>
          <PenLine /><span className="sr-only">Compose</span>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={(
              <Button
                aria-label={otherMailboxUnreadCount > 0
                  ? `Account and mailboxes, ${otherMailboxUnreadCount} unread in other mailboxes`
                  : "Account and mailboxes"}
                variant="ghost"
                className="h-10 max-w-60 gap-2.5 rounded-md border border-border bg-surface py-0 pr-2.5 pl-1.5 hover:bg-accent"
              />
            )}
          >
            <Avatar className="size-8">
              <AvatarImage src={auth.user?.avatarUrl ?? undefined} />
              <AvatarFallback className="text-[11px]">{auth.user?.name.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="hidden min-w-0 text-left md:block">
              <span className="block truncate text-[0.8125rem] leading-tight font-semibold text-foreground">
                {mailbox?.displayName ?? "Mailbox"}
              </span>
              <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                {mailbox?.address}
              </span>
            </span>
            {otherMailboxUnreadCount > 0 && (
              <span
                className="min-w-5 shrink-0 rounded-full bg-primary px-1.5 py-1 text-center text-[10px] leading-none font-bold text-primary-foreground tabular-nums"
                aria-hidden="true"
              >
                {otherMailboxUnreadLabel}
              </span>
            )}
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-80">
            <div className="flex items-center gap-3 px-2 py-2">
              <Avatar className="size-10">
                <AvatarImage src={auth.user?.avatarUrl ?? undefined} />
                <AvatarFallback className="text-xs">{auth.user?.name.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{auth.user?.name}</p>
                <p className="truncate text-xs text-muted-foreground capitalize">{auth.user?.role}</p>
              </div>
            </div>

            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Mailboxes</DropdownMenuLabel>
              {mailboxes.map((item) => {
                const active = item.id === mailbox?.id;
                return (
                  <DropdownMenuItem key={item.id} onClick={() => onMailboxChange(item.id)}>
                    <span
                      className={cn(
                        "grid size-7 shrink-0 place-items-center rounded-md",
                        active
                          ? "bg-primary/20 text-foreground"
                          : "bg-surface-sunken text-muted-foreground",
                      )}
                    >
                      <Mail className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.8125rem] font-medium">{item.displayName}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{item.address}</span>
                    </span>
                    {item.unreadCount > 0 && (
                      <span
                        className="min-w-5 shrink-0 rounded-full bg-primary/16 px-1.5 py-0.5 text-center text-[10px] leading-none font-bold text-foreground tabular-nums"
                        aria-label={`${item.unreadCount} unread messages`}
                      >
                        {item.unreadCount}
                      </span>
                    )}
                    {active && <Check className="shrink-0 text-primary" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>

            <DropdownMenuSeparator />
            {drive.isSuccess && (
              <DropdownMenuItem onClick={() => navigate("/drive")}>
                <HardDrive />Drive
              </DropdownMenuItem>
            )}
            {auth.modules.calendar && (
              <DropdownMenuItem onClick={() => navigate("/calendar")}>
                <CalendarDays />Calendar
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => navigate("/settings")}>
              <Settings />Settings
            </DropdownMenuItem>
            {auth.user?.role === "admin" && (
              <DropdownMenuItem onClick={onAdministration}><Settings2 />Administration</DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onClick={() => void auth.logout()}>
              <UserRound />Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
