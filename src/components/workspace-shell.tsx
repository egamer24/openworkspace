import {
  Inbox,
  LoaderCircle,
  Settings,
  Settings2,
  UserRound,
} from "lucide-react";
import { Suspense } from "react";
import { Outlet, useNavigate } from "react-router";
import { useAuth } from "@/auth/auth-context";
import { AppSwitcher } from "@/components/app-switcher";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function AccountMenu() {
  const auth = useAuth();
  const navigate = useNavigate();
  const initials = auth.user?.name.slice(0, 2).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button
            aria-label="Account"
            variant="ghost"
            className="h-10 gap-2.5 rounded-md border border-border bg-surface py-0 pr-2.5 pl-1.5 hover:bg-accent"
          />
        )}
      >
        <Avatar className="size-8">
          <AvatarImage src={auth.user?.avatarUrl ?? undefined} />
          <AvatarFallback className="text-[11px]">{initials}</AvatarFallback>
        </Avatar>
        <span className="hidden max-w-40 truncate text-[0.8125rem] font-semibold md:block">
          {auth.user?.name}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => navigate("/settings")}>
          <Settings />Settings
        </DropdownMenuItem>
        {auth.user?.role === "admin" && (
          <DropdownMenuItem onClick={() => navigate("/admin")}>
            <Settings2 />Administration
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => void auth.logout()}>
          <UserRound />Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Frame for the Git and Tasks apps; Mail keeps its own header. */
export function WorkspaceShell() {
  return (
    <main className="flex h-dvh min-h-0 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-3 sm:px-5">
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground">
            <Inbox className="size-4.5" strokeWidth={2.25} />
          </span>
          <span className="hidden text-sm leading-none font-semibold tracking-[-0.01em] xl:inline">
            OpenWorkspace
          </span>
        </div>
        <AppSwitcher />
        <div className="ml-auto">
          <AccountMenu />
        </div>
      </header>
      <div className="paper-grain min-h-0 flex-1 overflow-y-auto">
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
    </main>
  );
}
