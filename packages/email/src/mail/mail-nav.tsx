import { Skeleton, TooltipProvider, cn } from "@open-workspace/core/ui";
import { ChevronRight, PenLine } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";

import { FolderGlyph } from "./folder-glyph";
import { FolderManager } from "./folder-manager";
import { orderedFolders, unreadOf } from "./mail-folders";
import { CountPill, Monogram } from "./mail-primitives";
import type { Mailbox, MailFolder } from "./types";
import type { MailController } from "./use-mail-controller";
import { useFolders } from "./use-mail-data";

export function MailboxGlyph({
  mailbox,
  active,
  className,
}: {
  mailbox: Mailbox;
  active: boolean;
  className?: string;
}) {
  return (
    <Monogram
      name={mailbox.displayName}
      className={cn(
        "size-5 rounded-[6px] text-[9px] tracking-wide",
        mailbox.kind === "shared" && "rounded-full",
        active && "bg-primary! text-primary-foreground!",
        className
      )}
    />
  );
}

export function ComposeButton({
  disabled,
  iconOnly = false,
  onClick,
}: {
  disabled: boolean;
  iconOnly?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={iconOnly ? "New message" : undefined}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "bg-primary text-primary-foreground flex shrink-0 items-center justify-center gap-2 rounded-[10px] font-semibold outline-none",
        "shadow-[inset_0_1px_0_oklch(1_0_0/0.18),0_1px_2px_oklch(0.3_0.1_266/0.25)] transition-[filter,transform]",
        "focus-visible:ring-ring focus-visible:ring-offset-surface hover:brightness-110 focus-visible:ring-2 focus-visible:ring-offset-2 active:scale-[0.98]",
        "disabled:pointer-events-none disabled:opacity-50",
        iconOnly ? "size-10" : "h-9 w-full text-[13px]"
      )}
    >
      <PenLine className="size-4" />
      {!iconOnly && "New message"}
    </button>
  );
}

function FolderRow({
  folder,
  active,
  onSelect,
}: {
  folder: MailFolder;
  active: boolean;
  onSelect: () => void;
}) {
  const unread = unreadOf(folder);

  return (
    <li>
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
        className={cn(
          "relative flex h-7.5 w-full items-center gap-2.5 rounded-md pr-1 pl-2.5 text-left text-[13px] transition-colors outline-none",
          "focus-visible:ring-sidebar-ring focus-visible:ring-2",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground before:bg-sidebar-primary font-semibold before:absolute before:top-1.5 before:bottom-1.5 before:-left-[9px] before:w-[3px] before:rounded-full"
            : "text-sidebar-foreground hover:bg-foreground/[0.045]",
          unread > 0 && !active && "text-foreground font-semibold"
        )}
      >
        <FolderGlyph
          folder={folder}
          className={cn(
            "size-[15px] shrink-0",
            active ? "text-sidebar-primary" : "text-muted-foreground"
          )}
          strokeWidth={active ? 2.1 : 1.8}
        />
        <span className="min-w-0 flex-1 truncate">{folder.name}</span>
        <CountPill
          count={unread}
          strong={active || folder.systemType === "inbox"}
          label={
            folder.systemType === "drafts"
              ? `${unread} drafts`
              : `${unread} unread`
          }
        />
      </button>
    </li>
  );
}

const EXPANDED_KEY = "openworkspace.mail.expandedMailboxes";

/** What `writeExpanded` stores: the ids of the expanded mailboxes. */
const expandedIds = z.array(z.string());

function readExpanded(): string[] {
  try {
    const stored = expandedIds.safeParse(
      JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]")
    );

    return stored.success ? stored.data : [];
  } catch {
    return [];
  }
}

function writeExpanded(ids: string[]) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(ids));
  } catch {
    // Private windows and blocked storage: the tree just doesn't remember.
  }
}

/**
 * Which mailboxes are open in the tree. Any number can be; the active one
 * opens when it becomes active, and the choice is kept on this device.
 */
function useExpandedMailboxes(activeId: string | undefined) {
  const [expanded, setExpanded] = useState<string[]>(() => readExpanded());
  const [seenActive, setSeenActive] = useState<string | undefined>(undefined);

  if (activeId && activeId !== seenActive) {
    setSeenActive(activeId);

    if (!expanded.includes(activeId)) setExpanded([...expanded, activeId]);
  }

  useEffect(() => writeExpanded(expanded), [expanded]);

  return {
    isExpanded: (id: string) => expanded.includes(id),
    toggle: (id: string) =>
      setExpanded((current) =>
        current.includes(id)
          ? current.filter((item) => item !== id)
          : [...current, id]
      ),
    open: (id: string) =>
      setExpanded((current) =>
        current.includes(id) ? current : [...current, id]
      ),
  };
}

/**
 * Compose on top, then every mailbox as a tree node. Any number of mailboxes
 * can be open at once, each listing its folders with counts; closed ones show
 * their unread badge.
 */
export function NavTree({ mail }: { mail: MailController }) {
  const { mailbox: activeMailbox } = mail;
  const tree = useExpandedMailboxes(activeMailbox?.id);

  return (
    <TooltipProvider delay={300}>
      <nav
        aria-label="Mailboxes and folders"
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="shrink-0 p-2.5 pb-1">
          <ComposeButton
            disabled={!mail.mailbox?.canSend}
            onClick={mail.openCompose}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
          <p className="text-muted-foreground px-2 pt-3 pb-1.5 text-[11px] font-semibold tracking-[0.06em] uppercase">
            Mailboxes
          </p>
          {mail.mailboxQuery.isLoading ? (
            <div className="space-y-2 px-2 pt-1">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-5 w-full" />
              ))}
            </div>
          ) : (
            <ul className="space-y-0.5">
              {mail.mailboxes.map((item) => {
                const active = item.id === activeMailbox?.id;
                const expanded = tree.isExpanded(item.id);

                return (
                  <li key={item.id}>
                    <div className="group hover:bg-foreground/[0.045] flex h-8 w-full items-center rounded-md pr-1 transition-colors">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Collapse" : "Expand"} ${item.displayName}`}
                        onClick={() => tree.toggle(item.id)}
                        className="focus-visible:ring-sidebar-ring grid size-6 shrink-0 place-items-center rounded-md outline-none focus-visible:ring-2"
                      >
                        <ChevronRight
                          aria-hidden="true"
                          className={cn(
                            "text-muted-foreground size-3.5 transition-transform duration-150",
                            expanded && "rotate-90"
                          )}
                        />
                      </button>
                      <button
                        type="button"
                        title={item.address}
                        aria-current={active ? "true" : undefined}
                        onClick={() => {
                          tree.open(item.id);

                          if (!active) mail.selectMailbox(item.id);
                        }}
                        className="focus-visible:ring-sidebar-ring flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-2"
                      >
                        <MailboxGlyph mailbox={item} active={active} />
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate pl-0.5 text-[13px] leading-tight",
                            active
                              ? "text-foreground font-semibold"
                              : "text-sidebar-foreground font-medium"
                          )}
                        >
                          {item.displayName}
                        </span>
                        {!expanded && (
                          <CountPill
                            count={item.unreadCount}
                            strong
                            label={`${item.unreadCount} unread in ${item.displayName}`}
                          />
                        )}
                      </button>
                    </div>
                    {expanded && (
                      <MailboxFolders
                        mailbox={item}
                        activeFolder={active ? mail.folder : null}
                        onSelect={(folder) => {
                          mail.openFolder(item.id, folder);
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </nav>
    </TooltipProvider>
  );
}

/** One open mailbox's folders, loaded for that mailbox. */
function MailboxFolders({
  mailbox,
  activeFolder,
  onSelect,
}: {
  mailbox: Mailbox;
  /** The selected folder when this is the active mailbox. */
  activeFolder: string | null;
  onSelect: (folder: string) => void;
}) {
  const foldersQuery = useFolders(mailbox.id);
  const folders = foldersQuery.data?.folders ?? [];

  return (
    <div className="border-sidebar-border relative mt-0.5 mb-2 ml-[13px] border-l pl-2">
      {foldersQuery.isLoading ? (
        <div className="space-y-2 py-1.5 pl-2">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-4 w-4/5" />
          ))}
        </div>
      ) : (
        <>
          {/* The mailbox's address heads its one list of folders, with their settings beside it. */}
          <div className="flex h-7 items-center gap-1 pl-2.5">
            <p className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]">
              {mailbox.address}
            </p>
            <span className="[&_button]:size-6 [&_button]:rounded-md [&_svg]:size-3.5">
              <FolderManager
                mailboxId={mailbox.id}
                activeFolderId={activeFolder ?? "inbox"}
                folders={folders}
                onSelectFolder={onSelect}
              />
            </span>
          </div>
          <ul className="space-y-px">
            {orderedFolders(folders).map((entry) => (
              <FolderRow
                key={entry.id}
                folder={entry}
                active={entry.id === activeFolder}
                onSelect={() => onSelect(entry.id)}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
