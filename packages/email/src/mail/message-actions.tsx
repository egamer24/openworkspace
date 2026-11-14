import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuShortcut,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@open-workspace/core/ui";
import {
  Download,
  Ellipsis,
  FileText,
  Forward,
  Globe,
  Languages,
  ListFilter,
  Mail,
  MailMinus,
  OctagonAlert,
  Printer,
  RotateCw,
  ShieldBan,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";

import { ReplyActionIcon } from "./conversation-reply";
import { senderName } from "./message-format";
import { languageName } from "./message-translation";
import type { MessageTranslationState } from "./message-translation";
import { printMessage, renderedMessageHtml } from "./print-message";
import { ToolbarTooltip } from "./toolbar-tooltip";
import type { MessageDetail, ReplyAction } from "./types";

/** Apple Mail's "Raw Source" chord, which ConversationView listens for. */
const originalShortcutLabel =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/u.test(navigator.platform)
    ? "⌥⌘U"
    : "Ctrl+Alt+U";

export type MessageHandlers = {
  onViewed: () => Promise<void>;
  onReply: (action: ReplyAction) => void;
  onForward: () => void;
  onResend: () => void;
  /** Present when the message has a stored original to inspect. */
  onShowOriginal?: () => void;
  /** Download URL of the stored original (.eml). */
  originalUrl?: string;
  /** Marks this message unread again; incoming messages only. */
  onMarkUnread?: () => void;
  /** Sender-level actions; absent for outgoing messages. */
  sender?: SenderHandlers;
};

export type SenderHandlers = {
  onUnsubscribe?: () => void;
  onBlock?: () => void;
  onUnblock?: () => void;
  /** Opens a new rule with this sender (and list) filled in. */
  onFilter?: () => void;
  /** Reporting spam moves the conversation to Spam; absent where that makes no sense. */
  onReportSpam?: () => void;
  /** "Looks safe": trusts the sender and hides caution hints. */
  onTrust?: () => void;
};

/** An outgoing message whose submission failed or was never confirmed. */
export function canRetry(message: MessageDetail) {
  return (
    message.direction === "outgoing" &&
    (message.transportState === "failed" ||
      message.transportState === "unconfirmed")
  );
}

export function actionButtonLabel(action: ReplyAction) {
  if (action.mode === "reply_all") return "Reply all";

  if (action.mode === "reply_list") return "Reply to list";

  if (action.mode === "continue") return "Follow up";

  return "Reply";
}

/** A message's reply button and its "More actions" menu. */
export function MessageActions({
  message,
  canForward,
  translation,
  resendPending,
  handlers,
}: {
  message: MessageDetail;
  mailboxId?: string;
  canForward: boolean;
  translation: MessageTranslationState;
  resendPending: boolean;
  handlers: MessageHandlers;
}) {
  const [primaryAction, ...otherActions] = message.replyPlan.actions;
  const senderHandlers = handlers.sender;

  return (
    <div className="-mr-1.5 flex shrink-0 items-center">
      {primaryAction && (
        <IconAction
          label={`${actionButtonLabel(primaryAction)} to this message`}
          tooltip={actionButtonLabel(primaryAction)}
          onClick={() => handlers.onReply(primaryAction)}
        >
          <ReplyActionIcon mode={primaryAction.mode} />
        </IconAction>
      )}
      <DropdownMenu>
        <ToolbarTooltip label="More actions" side="bottom">
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="More actions"
                className="text-muted-foreground hover:text-foreground"
              />
            }
          >
            <Ellipsis />
          </DropdownMenuTrigger>
        </ToolbarTooltip>
        <DropdownMenuContent align="end" className="w-64">
          {menuGroups([
            [
              ...otherActions.map((action) => (
                <DropdownMenuItem
                  key={action.mode}
                  aria-label={`${actionButtonLabel(action)} to this message`}
                  onClick={() => handlers.onReply(action)}
                >
                  <ReplyActionIcon mode={action.mode} />{" "}
                  {actionButtonLabel(action)}
                </DropdownMenuItem>
              )),
              canForward && (
                <DropdownMenuItem
                  key="forward"
                  aria-label="Forward this message"
                  onClick={handlers.onForward}
                >
                  <Forward /> Forward
                </DropdownMenuItem>
              ),
            ],
            [
              handlers.onMarkUnread && (
                <DropdownMenuItem key="unread" onClick={handlers.onMarkUnread}>
                  <Mail /> Mark as unread from here
                </DropdownMenuItem>
              ),
              canRetry(message) && (
                <DropdownMenuItem
                  key="resend"
                  disabled={resendPending}
                  onClick={handlers.onResend}
                >
                  <RotateCw />{" "}
                  {message.transportState === "failed"
                    ? "Retry sending"
                    : "Send again"}
                </DropdownMenuItem>
              ),
            ],
            [
              senderHandlers?.onUnsubscribe && (
                <DropdownMenuItem
                  key="unsubscribe"
                  onClick={senderHandlers.onUnsubscribe}
                >
                  <MailMinus /> Unsubscribe
                </DropdownMenuItem>
              ),
              message.sender?.block &&
              !message.sender.block.workspace &&
              senderHandlers?.onUnblock ? (
                <DropdownMenuItem
                  key="unblock"
                  onClick={senderHandlers.onUnblock}
                >
                  <ShieldCheck />{" "}
                  <span className="truncate">
                    Unblock “{message.sender.block.pattern}”
                  </span>
                </DropdownMenuItem>
              ) : !message.sender?.block && senderHandlers?.onBlock ? (
                <DropdownMenuItem key="block" onClick={senderHandlers.onBlock}>
                  <ShieldBan />{" "}
                  <span className="truncate">
                    Block “{senderName(message)}”
                  </span>
                </DropdownMenuItem>
              ) : null,
              senderHandlers?.onFilter && (
                <DropdownMenuItem
                  key="filter"
                  onClick={senderHandlers.onFilter}
                >
                  <ListFilter /> Filter messages like this
                </DropdownMenuItem>
              ),
            ],
            [
              senderHandlers?.onReportSpam && (
                <DropdownMenuItem
                  key="spam"
                  onClick={senderHandlers.onReportSpam}
                >
                  <OctagonAlert /> Report spam
                </DropdownMenuItem>
              ),
            ],
            translation.available
              ? [
                  translation.visible ? (
                    <DropdownMenuItem
                      key="original-language"
                      onClick={translation.showOriginal}
                    >
                      <Languages /> Show original language
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      key="translate"
                      disabled={!translation.ready || translation.pending}
                      onClick={() => void translation.translate()}
                    >
                      <Languages />
                      {translation.hasResult
                        ? "Show translation"
                        : `Translate to ${languageName(translation.language)}`}
                    </DropdownMenuItem>
                  ),
                  <DropdownMenuSub key="translate-to">
                    <DropdownMenuSubTrigger
                      disabled={!translation.ready || translation.pending}
                    >
                      <Globe />
                      Translate to…
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="max-h-80 w-48 overflow-y-auto">
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>
                          Translation language
                        </DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          value={translation.language}
                          onValueChange={(code: string) =>
                            void translation.translate(code)
                          }
                        >
                          {translation.languages.map((code) => (
                            <DropdownMenuRadioItem key={code} value={code}>
                              {languageName(code)}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>,
                ]
              : [],
            [
              <DropdownMenuItem
                key="print"
                onClick={() =>
                  printMessage(message, renderedMessageHtml(message.id))
                }
              >
                <Printer /> Print
              </DropdownMenuItem>,
              handlers.originalUrl && (
                <DropdownMenuItem
                  key="download"
                  render={
                    // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- Base UI renders the menu item's content inside this anchor
                    <a
                      href={handlers.originalUrl}
                      download={`${message.id}.eml`}
                    />
                  }
                >
                  <Download /> Download message
                </DropdownMenuItem>
              ),
              handlers.onShowOriginal && (
                <DropdownMenuItem
                  key="original"
                  onClick={handlers.onShowOriginal}
                >
                  <FileText /> Show original
                  <DropdownMenuShortcut>
                    {originalShortcutLabel}
                  </DropdownMenuShortcut>
                </DropdownMenuItem>
              ),
            ],
          ])}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Renders menu groups with separators only between groups that have items. */
function menuGroups(groups: (ReactNode | false | undefined)[][]) {
  const filled = groups.flatMap((items) => {
    const present = items.filter(Boolean);

    return present.length > 0 ? [present] : [];
  });

  return filled.map((items, index) => (
    <DropdownMenuGroup key={index}>
      {index > 0 && <DropdownMenuSeparator />}
      {items}
    </DropdownMenuGroup>
  ));
}

function IconAction({
  label,
  tooltip,
  onClick,
  children,
}: {
  label: string;
  tooltip: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <ToolbarTooltip label={tooltip} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        className="text-muted-foreground hover:text-foreground"
        onClick={onClick}
      >
        {children}
      </Button>
    </ToolbarTooltip>
  );
}
