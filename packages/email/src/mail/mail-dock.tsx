import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useActiveInView,
  useEdgeFade,
  cn,
} from "@open-workspace/core/ui";
import { FolderCog, PenLine } from "lucide-react";
import { useRef } from "react";

import { FolderGlyph } from "./folder-glyph";
import { orderedFolders, unreadOf } from "./mail-folders";
import { DockMailboxSwitcher } from "./mail-mailbox-sheet";
import type { MailController } from "./use-mail-controller";

/**
 * Mobile bottom dock, read left to right: the mailbox (when there are
 * several to switch between), then every folder of it in one scrolling row
 * with a gear for folder settings at its end, and compose beside it.
 */
export function MobileDock({
  mail,
  onManageFolders,
}: {
  mail: MailController;
  onManageFolders: () => void;
}) {
  const folders = orderedFolders(mail.folders ?? []);
  const scroller = useRef<HTMLDivElement>(null);
  const fade = useEdgeFade(scroller);
  useActiveInView(scroller, `${mail.folder} ${folders.length}`);

  const tabClass =
    "relative flex h-12 shrink-0 snap-start flex-col items-center justify-center gap-0.5 rounded-xl px-2 text-[10.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(0.625rem+env(safe-area-inset-bottom))] z-30 flex justify-center gap-2 px-3 sm:bottom-20 lg:hidden">
      <nav
        aria-label="Mailbox and folders"
        className="mail-pane pointer-events-auto flex w-full max-w-sm min-w-0 items-center overflow-hidden rounded-2xl shadow-[0_8px_24px_-10px_var(--shadow-color-strong),0_1px_2px_var(--shadow-color-weak)]"
      >
        {mail.mailboxes.length > 1 && (
          <div className="flex shrink-0 items-center py-1 pl-1">
            <DockMailboxSwitcher mail={mail} />
            <span aria-hidden="true" className="bg-border ml-1 h-7 w-px" />
          </div>
        )}
        <div
          ref={scroller}
          data-dock-scroller
          style={fade}
          className="relative flex min-w-0 flex-1 snap-x snap-proximity scroll-px-5 [scrollbar-width:none] items-center gap-0.5 overflow-x-auto overscroll-x-contain p-1 [&::-webkit-scrollbar]:hidden"
        >
          {folders.map((item) => {
            const active = item.id === mail.folder;
            const unread = unreadOf(item);

            return (
              <button
                key={item.id}
                type="button"
                data-active={active || undefined}
                aria-current={active ? "page" : undefined}
                aria-label={`${item.name}${unread ? `, ${unread} unread` : ""}`}
                title={item.kind === "custom" ? item.name : undefined}
                onClick={() => mail.selectFolder(item.id)}
                className={cn(
                  tabClass,
                  // System folders sit at one width; a long name of your own truncates.
                  item.kind === "system" ? "w-16" : "max-w-28 min-w-16",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <FolderGlyph
                  folder={item}
                  className={cn(
                    "size-[18px] shrink-0",
                    active && "text-sidebar-primary"
                  )}
                  strokeWidth={active ? 2.1 : 1.8}
                />
                <span className="max-w-full truncate">{item.name}</span>
                {unread > 0 && (
                  <span
                    aria-hidden="true"
                    className="bg-primary text-primary-foreground absolute top-1 left-[calc(50%+4px)] min-w-4 rounded-full px-1 text-center text-[9px] leading-4 font-bold tabular-nums"
                  >
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </button>
            );
          })}
          {folders.length > 0 && (
            <>
              <span
                aria-hidden="true"
                className="bg-border mx-0.5 h-7 w-px shrink-0"
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-haspopup="dialog"
                      aria-label="Manage folders and AI sorting"
                      onClick={onManageFolders}
                      className={cn(
                        tabClass,
                        "text-muted-foreground hover:text-foreground w-11"
                      )}
                    />
                  }
                >
                  <FolderCog className="size-[18px]" strokeWidth={1.8} />
                </TooltipTrigger>
                <TooltipContent>Manage folders</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      </nav>
      <button
        type="button"
        aria-label="New message"
        disabled={!mail.mailbox?.canSend}
        onClick={mail.openCompose}
        className="bg-primary text-primary-foreground focus-visible:ring-ring pointer-events-auto grid size-14 shrink-0 place-items-center rounded-2xl shadow-[inset_0_1px_0_oklch(1_0_0/0.2),0_8px_20px_-8px_var(--primary)] transition-[filter,transform] outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-offset-2 active:scale-95 disabled:opacity-50"
      >
        <PenLine className="size-5" />
      </button>
    </div>
  );
}
