import { cn } from "@open-workspace/core/ui";
import { lazy, Suspense, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { AutoReplyBanner } from "./auto-reply-banner";
import { ConversationList } from "./conversation-list";
import { FolderManager } from "./folder-manager";
import { AppBar } from "./mail-app-bar";
import { MobileDock } from "./mail-dock";
import type { MailRoute } from "./mail-location";
import { NavTree } from "./mail-nav";
import { NavRail } from "./mail-nav-rail";
import { PaneSplitter, useListWidth } from "./pane-splitter";
import { ReaderPane } from "./reader-pane";
import { useMailController } from "./use-mail-controller";

const ComposeWindow = lazy(async () => {
  const module = await import("./compose-window");

  return { default: module.ComposeWindow };
});

/**
 * Workspace layout: a top bar with global search over separate solid panes —
 * navigation (mailbox tree, or an icon rail below xl), a dense column list and
 * a reading pane with its own command bar, split by a resizable gap. Below lg
 * it is one pane at a time with a bottom dock of every folder.
 */
/** The list pane's width, as the CSS variable the layout reads. */
function listWidthStyle(
  width: number
): CSSProperties & Record<"--mail-list-w", string> {
  return {
    "--mail-list-w": `clamp(20rem, ${width}px, calc(100% - 26.625rem))`,
  };
}

export function MailShell({ route }: { route: MailRoute }) {
  const mail = useMailController(route, { listWithConversation: true });
  /** Folder settings opened from the phone's dock. */
  const [managingFolders, setManagingFolders] = useState(false);
  const reading = Boolean(mail.conversationId);
  const mainRef = useRef<HTMLElement>(null);
  const [listWidth, setListWidth] = useListWidth();

  return (
    <div className="bg-background text-foreground flex h-dvh min-h-0 flex-col gap-1.5 overflow-hidden p-2 pt-1 text-[13px] lg:gap-2 lg:p-2.5 lg:pt-1.5">
      <AppBar mail={mail} />
      {mail.mailbox ? <AutoReplyBanner mailbox={mail.mailbox} /> : null}

      <div className="flex min-h-0 flex-1 gap-2.5">
        <aside
          aria-label="Navigation"
          className="mail-pane hidden w-16 shrink-0 flex-col overflow-hidden lg:flex xl:hidden"
        >
          <NavRail mail={mail} />
        </aside>
        <aside
          aria-label="Navigation"
          className="mail-pane hidden w-60 shrink-0 flex-col overflow-hidden xl:flex"
        >
          <NavTree mail={mail} />
        </aside>

        <main
          ref={mainRef}
          style={listWidthStyle(listWidth)}
          className="flex min-w-0 flex-1"
        >
          <section
            aria-label="Conversation list"
            className={cn(
              "mail-pane min-w-0 flex-col overflow-hidden lg:flex lg:w-(--mail-list-w) lg:shrink-0",
              reading ? "hidden" : "flex flex-1 lg:flex-none"
            )}
          >
            <ConversationList mail={mail} />
          </section>
          <PaneSplitter
            containerRef={mainRef}
            width={listWidth}
            onWidthChange={setListWidth}
          />
          <section
            aria-label="Reading pane"
            className={cn(
              "mail-pane min-w-0 flex-1 flex-col overflow-hidden",
              reading ? "flex" : "hidden lg:flex"
            )}
          >
            <ReaderPane mail={mail} />
          </section>
        </main>
      </div>

      {!reading && !mail.selection.active && (
        <MobileDock
          mail={mail}
          onManageFolders={() => setManagingFolders(true)}
        />
      )}
      {mail.mailbox && (
        <FolderManager
          key={mail.mailbox.id}
          mailboxId={mail.mailbox.id}
          activeFolderId={mail.folder}
          folders={mail.folders ?? []}
          onSelectFolder={mail.selectFolder}
          controlled={{
            open: managingFolders,
            onOpenChange: setManagingFolders,
          }}
        />
      )}

      {mail.composeOpen && mail.mailbox && (
        <Suspense fallback={null}>
          <ComposeWindow
            key={`${mail.mailbox.id}:${mail.forwardedMessage?.id ?? "compose"}`}
            mailbox={mail.mailbox}
            forwardedMessage={mail.forwardedMessage}
            onClose={mail.closeComposer}
          />
        </Suspense>
      )}
    </div>
  );
}
