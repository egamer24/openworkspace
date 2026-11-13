import { TooltipProvider, cn } from "@open-workspace/core/ui";

import { FolderGlyph } from "./folder-glyph";
import { FolderManager } from "./folder-manager";
import { orderedFolders, unreadOf } from "./mail-folders";
import { ComposeButton, MailboxGlyph } from "./mail-nav";
import { ToolbarTooltip } from "./toolbar-tooltip";
import type { MailController } from "./use-mail-controller";

const railItemClass =
  "relative grid size-10 place-items-center rounded-[10px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring";

function UnreadDot() {
  return (
    <span
      aria-hidden="true"
      className="bg-primary ring-surface absolute top-1.5 right-1.5 size-2 rounded-full ring-2"
    />
  );
}

/**
 * Icon rail used between lg and xl: compose, mailboxes, the active mailbox's
 * folders, then settings. Labels move into tooltips.
 */
export function NavRail({ mail }: { mail: MailController }) {
  const { folders, folder } = mail;
  const railFolders = orderedFolders(folders ?? []);

  return (
    <TooltipProvider delay={200}>
      <nav
        aria-label="Mailboxes and folders"
        className="flex min-h-0 flex-1 flex-col items-center"
      >
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto px-2 py-2.5">
          <ToolbarTooltip label="New message" side="right">
            <ComposeButton
              disabled={!mail.mailbox?.canSend}
              iconOnly
              onClick={mail.openCompose}
            />
          </ToolbarTooltip>

          <span
            aria-hidden="true"
            className="bg-sidebar-border my-1.5 h-px w-7 shrink-0"
          />
          {mail.mailboxes.map((item) => {
            const active = item.id === mail.mailbox?.id;

            return (
              <ToolbarTooltip
                key={item.id}
                side="right"
                label={`${item.displayName}${item.unreadCount ? ` · ${item.unreadCount} unread` : ""}`}
              >
                <button
                  type="button"
                  aria-current={active ? "true" : undefined}
                  aria-label={`${item.displayName}${item.unreadCount && !active ? `, ${item.unreadCount} unread` : ""}`}
                  onClick={() => mail.selectMailbox(item.id)}
                  className={cn(
                    railItemClass,
                    active ? "bg-sidebar-accent" : "hover:bg-foreground/[0.045]"
                  )}
                >
                  <MailboxGlyph
                    mailbox={item}
                    active={active}
                    className="size-6 text-[10px]"
                  />
                  {!active && item.unreadCount > 0 && <UnreadDot />}
                </button>
              </ToolbarTooltip>
            );
          })}

          <span
            aria-hidden="true"
            className="bg-sidebar-border my-1.5 h-px w-7 shrink-0"
          />
          {railFolders.map((entry) => {
            const active = entry.id === folder;
            const unread = unreadOf(entry);

            return (
              <ToolbarTooltip
                key={entry.id}
                side="right"
                label={`${entry.name}${unread ? ` · ${unread} unread` : ""}`}
              >
                <button
                  type="button"
                  aria-current={active ? "page" : undefined}
                  aria-label={`${entry.name}${unread ? `, ${unread} unread` : ""}`}
                  onClick={() => mail.selectFolder(entry.id)}
                  className={cn(
                    railItemClass,
                    active
                      ? "bg-sidebar-accent text-sidebar-primary"
                      : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground"
                  )}
                >
                  <FolderGlyph
                    folder={entry}
                    className="size-[17px]"
                    strokeWidth={active ? 2.1 : 1.8}
                  />
                  {unread > 0 && <UnreadDot />}
                </button>
              </ToolbarTooltip>
            );
          })}
          {mail.mailbox && (
            <span className="mt-0.5 [&_button]:size-10 [&_button]:rounded-[10px]">
              <FolderManager
                mailboxId={mail.mailbox.id}
                activeFolderId={folder}
                folders={folders ?? []}
                onSelectFolder={mail.selectFolder}
              />
            </span>
          )}
        </div>
      </nav>
    </TooltipProvider>
  );
}
