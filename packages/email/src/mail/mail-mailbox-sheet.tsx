import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  cn,
} from "@open-workspace/core/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { z } from "zod";

import { folderAfterMailboxSwitch } from "./mail-folders";
import { MailboxGlyph } from "./mail-nav";
import { CountPill } from "./mail-primitives";
import { conversationsQuery, foldersQuery } from "./mail-queries";
import type { Mailbox } from "./types";
import type { MailController } from "./use-mail-controller";

/** What names a mailbox in tight spots: the address for a person's own, the name for a shared one. */
export function mailboxCaption(mailbox: Mailbox) {
  return mailbox.kind === "shared" ? mailbox.displayName : mailbox.address;
}

/** The quiet line over the phone's list title: which mailbox the folder belongs to. */
export function MailboxCaption({ mail }: { mail: MailController }) {
  if (!mail.mailbox) return null;

  return (
    <p className="text-muted-foreground truncate text-xs leading-4">
      {mailboxCaption(mail.mailbox)}
    </p>
  );
}

/**
 * The dock's first button: the current mailbox's avatar, opening a sheet to
 * switch. A dot marks unread mail in the others. With one mailbox there is
 * nothing to switch to, so there is no button.
 */
export function DockMailboxSwitcher({ mail }: { mail: MailController }) {
  const sheet = useMailboxSheet();
  const { mailbox, mailboxes } = mail;

  if (!mailbox || mailboxes.length < 2) return null;

  const unreadElsewhere = mailboxes.some(
    (item) => item.id !== mailbox.id && item.unreadCount > 0
  );

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={sheet.open}
        aria-label={`Mailbox: ${mailbox.displayName}${unreadElsewhere ? ", unread mail in other mailboxes" : ""}`}
        title={mailboxCaption(mailbox)}
        onClick={sheet.show}
        className={cn(
          "text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-12 shrink-0 items-center gap-0.5 rounded-xl pr-1 pl-2 outline-none focus-visible:ring-2",
          sheet.open && "bg-sidebar-accent text-foreground"
        )}
      >
        <span className="relative shrink-0">
          <MailboxGlyph
            mailbox={mailbox}
            active={false}
            className="size-7 text-[10.5px]"
          />
          {unreadElsewhere && (
            <span
              aria-hidden="true"
              className="border-surface bg-primary absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2"
            />
          )}
        </span>
        <ChevronsUpDown
          aria-hidden="true"
          className="size-3.5 shrink-0"
          strokeWidth={2}
        />
      </button>
      <MailboxSheet mail={mail} open={sheet.open} onClose={sheet.close} />
    </>
  );
}

/**
 * Every mailbox the person can open, the current one checked. Picking one
 * keeps the folder when that mailbox has it, otherwise opens its Inbox.
 */
function MailboxSheet({
  mail,
  open,
  onClose,
}: {
  mail: MailController;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { folder, debouncedSearch, unreadOnly } = mail;

  // While the sheet is open, the other mailboxes' folders and the list a
  // switch would land on load, so picking one swaps the screen in a frame.
  const otherIds = mail.mailboxes
    .filter((item) => item.id !== mail.mailbox?.id)
    .map((item) => item.id)
    .join(" ");

  useEffect(() => {
    if (!open) return;

    for (const id of otherIds.split(" ").filter(Boolean)) {
      void queryClient
        .fetchQuery({ ...foldersQuery(id), staleTime: 30_000 })
        .then(
          (data) => {
            const target = folderAfterMailboxSwitch(folder, data.folders);
            void queryClient.prefetchInfiniteQuery({
              ...conversationsQuery(id, target, debouncedSearch, unreadOnly),
              staleTime: 30_000,
            });
          },
          () => undefined
        );
    }
  }, [open, otherIds, folder, debouncedSearch, unreadOnly, queryClient]);

  async function pick(mailbox: Mailbox) {
    if (mailbox.id === mail.mailbox?.id) {
      onClose();

      return;
    }

    const data = await queryClient
      .ensureQueryData(foldersQuery(mailbox.id))
      .catch(() => undefined);

    // Replaces the sheet's history entry, so Back returns to the mailbox before.
    mail.openFolder(
      mailbox.id,
      folderAfterMailboxSwitch(folder, data?.folders),
      true
    );
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="border-border bg-surface max-h-[min(85dvh,40rem)] gap-0 rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <div className="relative shrink-0 px-4 pt-2.5">
          <span
            aria-hidden="true"
            className="bg-foreground/15 mx-auto block h-1 w-9 rounded-full"
          />
          <SheetTitle className="mt-3 pr-10 text-[15px] font-semibold tracking-[-0.01em]">
            Mailboxes
          </SheetTitle>
          <SheetDescription className="pr-10 text-xs">
            Switch to another mailbox you can open
          </SheetDescription>
          <SheetClose
            aria-label="Close mailboxes"
            className="text-muted-foreground active:bg-foreground/[0.05] focus-visible:ring-ring absolute top-5 right-2.5 grid size-10 place-items-center rounded-full outline-none focus-visible:ring-2"
          >
            <X className="size-[18px]" />
          </SheetClose>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-3">
          {mail.mailboxes.map((item) => {
            const current = item.id === mail.mailbox?.id;

            return (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={current ? "true" : undefined}
                  onClick={() => void pick(item)}
                  className={cn(
                    // No color transition: the highlight moves at once, as in the folder lists.
                    "flex h-15 w-full items-center gap-3 rounded-xl px-3 text-left outline-none",
                    "focus-visible:ring-ring focus-visible:ring-2",
                    current
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-foreground active:bg-foreground/[0.05]"
                  )}
                >
                  <MailboxGlyph
                    mailbox={item}
                    active={current}
                    className="size-8 text-[11px]"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-[15px] leading-5",
                        current ? "font-semibold" : "font-medium"
                      )}
                    >
                      {item.displayName}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs leading-4">
                      {item.address}
                    </span>
                  </span>
                  <CountPill
                    count={item.unreadCount}
                    strong
                    label={`${item.unreadCount} unread`}
                    className="text-[11.5px] leading-4"
                  />
                  <Check
                    aria-hidden="true"
                    className={cn(
                      "text-sidebar-primary size-[18px] shrink-0",
                      !current && "invisible"
                    )}
                    strokeWidth={2.2}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </SheetContent>
    </Sheet>
  );
}

/** The history entry the mailbox sheet opened (see `show`). */
const sheetState = z.object({ mailboxSheet: z.literal(true) });

/** React Router's history state: the entry's position in this tab's history. */
const historyState = z.object({ idx: z.number() });

/**
 * The mailbox sheet is a history entry (location state), so the system Back
 * button closes it instead of leaving the folder.
 */
function useMailboxSheet() {
  const location = useLocation();
  const navigate = useNavigate();

  const open = sheetState.safeParse(location.state).success;

  const here = { pathname: location.pathname, search: location.search };

  return {
    open,
    show() {
      if (!open) navigate(here, { state: { mailboxSheet: true } });
    },
    close() {
      // After a reload the sheet's entry may be the first one; then it is replaced.
      const history = historyState.safeParse(window.history.state);
      const index = history.success ? history.data.idx : 0;

      if (index > 0) navigate(-1);
      else navigate(here, { replace: true, state: null });
    },
  };
}
