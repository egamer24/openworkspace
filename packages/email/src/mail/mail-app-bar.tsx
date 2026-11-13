import { avatarSrc } from "@open-workspace/core/shared";
import {
  useAuth,
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  AppearanceMenuRow,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
  initials,
  AppSwitcher,
  useWorkspaceBrand,
  WorkspaceLogo,
} from "@open-workspace/core/ui";
import { LogOut, Search, Settings, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef } from "react";

import { EMAIL_MODULE } from "../../shared/module";
import type { MailController } from "./use-mail-controller";

/** The workspace's logo and name, then the app switcher (the app's name). */
function ProductMark() {
  const brand = useWorkspaceBrand();

  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <WorkspaceLogo src={brand.logoUrl} flat />
      <span className="flex min-w-0 items-center gap-2 text-[14px] leading-none tracking-[-0.015em]">
        <span className="truncate font-semibold">{brand.name}</span>
        <span className="bg-border h-3.5 w-px shrink-0" />
        <AppSwitcher current={EMAIL_MODULE} />
      </span>
    </span>
  );
}

/** Where the header has no room for the workspace's name: its logo, then the app switcher. */
function CompactAppSwitcher({ className }: { className?: string }) {
  const brand = useWorkspaceBrand();

  return (
    <AppSwitcher
      current={EMAIL_MODULE}
      logo={<WorkspaceLogo src={brand.logoUrl} flat />}
      className={className}
    />
  );
}

function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName))
  );
}

/** Search input; with `shortcut`, "/" focuses it from anywhere outside a text field. */
export function SearchField({
  mail,
  className,
  shortcut = false,
}: {
  mail: MailController;
  className?: string;
  shortcut?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!shortcut) return;

    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        isTypingTarget(event.target)
      ) {
        return;
      }

      const input = inputRef.current;

      if (!input || input.offsetParent === null) return;
      event.preventDefault();
      input.focus();
    }

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcut]);

  return (
    <label
      className={cn(
        "border-border bg-surface flex min-w-0 items-center gap-2 rounded-lg border pr-1.5 pl-3 shadow-[var(--pane-shadow)] transition-[border-color,box-shadow]",
        "hover:border-input focus-within:border-ring focus-within:ring-ring/20 focus-within:ring-3",
        className
      )}
    >
      <span className="sr-only">Search in {mail.folderName}</span>
      <Search
        aria-hidden="true"
        className="text-muted-foreground size-3.5 shrink-0"
      />
      <input
        ref={inputRef}
        type="search"
        value={mail.search}
        placeholder={`Search ${mail.folderName.toLowerCase() === "inbox" ? "mail" : `in ${mail.folderName}`}`}
        onChange={(event) => mail.setSearch(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();

            if (mail.search) mail.setSearch("");
            else event.currentTarget.blur();
          }
        }}
        className="text-foreground placeholder:text-muted-foreground h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {mail.search ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            mail.setSearch("");
            inputRef.current?.focus();
          }}
          className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 grid size-6 shrink-0 place-items-center rounded-md outline-none focus-visible:ring-2"
        >
          <X className="size-3.5" />
        </button>
      ) : shortcut ? (
        <kbd className="border-border bg-surface-sunken text-muted-foreground hidden h-5 min-w-5 shrink-0 place-items-center rounded-[5px] border px-1.5 text-[11px] md:grid">
          /
        </kbd>
      ) : null}
    </label>
  );
}

function AccountMenu({ mail }: { mail: MailController }) {
  const auth = useAuth();
  const { user } = auth;
  const fallback = initials(user?.name ?? "?");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account: ${user?.name ?? "signed in"}`}
        className={cn(
          "flex h-9 shrink-0 items-center gap-2 rounded-[calc(var(--radius-lg)+2px)] p-0.5 transition-colors outline-none",
          "hover:bg-foreground/[0.05] focus-visible:ring-ring aria-expanded:bg-foreground/[0.05] focus-visible:ring-2 xl:pr-3"
        )}
      >
        <Avatar className="size-8">
          <AvatarImage src={avatarSrc(user)} />
          <AvatarFallback className="bg-primary/12 text-primary text-[11px] font-semibold">
            {fallback}
          </AvatarFallback>
        </Avatar>
        <span className="hidden max-w-36 truncate text-[13px] font-medium xl:block">
          {user?.name}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-68">
        <div className="flex items-center gap-3 px-2 py-2.5">
          <Avatar className="size-10">
            <AvatarImage src={avatarSrc(user)} />
            <AvatarFallback className="bg-primary/12 text-primary text-xs font-semibold">
              {fallback}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex h-5 min-w-0 items-center gap-1.5">
              <p className="truncate text-[13px] leading-5 font-semibold">
                {user?.name}
              </p>
              {user?.role === "admin" ? (
                <Badge
                  variant="outline"
                  className="h-4.5 px-1.5 text-[0.625rem]"
                >
                  Admin
                </Badge>
              ) : null}
            </div>
            <p className="text-muted-foreground mt-0.5 truncate text-xs leading-4">
              {mail.mailbox?.address}
            </p>
          </div>
        </div>
        <DropdownMenuSeparator />
        <AppearanceMenuRow />
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={mail.openSettings}>
          <Settings />
          Settings
        </DropdownMenuItem>
        {Boolean(user?.permissions.length) && (
          <DropdownMenuItem onClick={mail.openAdministration}>
            <ShieldCheck />
            Administration
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => void auth.logout()}
        >
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Top app bar on the canvas: brand aligned over the navigation pane, central
 * search, account. Compose lives in the navigation pane (and the mobile dock);
 * where you are (folder, mailbox) heads the conversation list. Below xl the
 * brand is the workspace's logo and the app's name, still the app switcher.
 */
export function AppBar({ mail }: { mail: MailController }) {
  return (
    <header className="grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-1 md:grid-cols-[auto_minmax(0,1fr)_auto] lg:gap-3 lg:px-0 xl:grid-cols-[15rem_minmax(0,1fr)_15rem]">
      <div className="flex min-w-0 items-center lg:pl-3.5 xl:pl-2.5">
        <CompactAppSwitcher className="xl:hidden" />
        <span className="hidden min-w-0 xl:flex">
          <ProductMark />
        </span>
      </div>

      <SearchField
        mail={mail}
        shortcut
        className="mx-auto hidden h-9 w-full max-w-2xl md:flex"
      />

      <div className="flex items-center justify-end md:col-start-3">
        <AccountMenu mail={mail} />
      </div>
    </header>
  );
}
