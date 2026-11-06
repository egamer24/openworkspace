import {
  Check,
  ChevronDown,
  LoaderCircle,
  Paperclip,
  Reply,
  ReplyAll,
  Send,
  Users,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { normalizeExternalEmailAddress } from "../../shared/mail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ComposerAttachmentList } from "./composer-attachment-list";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { RecipientCombobox } from "./recipient-combobox";
import {
  recipientsWithPendingInput,
  validateComposerRecipients,
  type RecipientFieldValue,
} from "./composer-recipients";
import {
  useReplySubmission,
  type SentReply,
} from "./use-reply-submission";
import type {
  Mailbox,
  MessageDetail,
  ReplyAction,
  ReplyActionMode,
} from "./types";
import { useComposerSession } from "./composer-session";
import { useComposerAttachmentPreflight } from "./use-composer-attachment-preflight";

export type { SentReply } from "./use-reply-submission";

const EMPTY_RECIPIENT_FIELD: RecipientFieldValue = {
  recipients: [],
  input: "",
};

function recipientField(addresses: string[]): RecipientFieldValue {
  return {
    recipients: addresses.map((address) => ({ address, name: null })),
    input: "",
  };
}

function recipientAddresses(value: RecipientFieldValue) {
  return recipientsWithPendingInput(value).map((recipient) => recipient.address);
}

function recipientAddressSet(value: RecipientFieldValue) {
  return new Set(
    recipientAddresses(value).map(normalizeExternalEmailAddress),
  );
}

export function ConversationReply({
  mailbox,
  parent,
  mode,
  onModeChange,
  onSent,
}: {
  mailbox?: Mailbox;
  parent: MessageDetail;
  mode: ReplyActionMode;
  onModeChange: (mode: ReplyActionMode) => void;
  onSent: (result: SentReply) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const initialAction = findAction(parent, mode);
  const signature = mailbox?.signature?.useOnReply ? mailbox.signature.text : "";
  const initialBody = signature ? `\n\n${signature}` : "";
  const [body, setBody] = useState(initialBody);
  const [cc, setCc] = useState(
    () => recipientField(initialAction?.cc ?? []),
  );
  const [bcc, setBcc] = useState<RecipientFieldValue>(EMPTY_RECIPIENT_FIELD);
  const [showCc, setShowCc] = useState(Boolean(initialAction?.cc.length));
  const [showBcc, setShowBcc] = useState(false);
  const { session, snapshot } = useComposerSession(mailbox?.id ?? "");
  const activeAssets = snapshot.assets;
  const uploadLimitError = session.limitError();
  const uploadsPending = activeAssets.some(
    (asset) => asset.status === "uploading",
  );
  const uploadsFailed = activeAssets.some(
    (asset) => asset.status === "error",
  );
  const action = useMemo(
    () => findAction(parent, mode),
    [mode, parent],
  );
  useEffect(() => {
    const next = findAction(parent, mode);
    setCc(recipientField(next.cc));
    setShowCc(next.cc.length > 0);
  }, [mode, parent.id]);
  const recipients = validateComposerRecipients({
    to: recipientField(action?.to ?? []),
    cc,
    bcc,
  });
  useComposerAttachmentPreflight(
    session,
    {
      kind: "reply",
      mailboxId: mailbox?.id ?? "",
      sourceEmailId: parent.id,
      mode: action?.mode ?? mode,
      cc: recipients.cc,
      bcc: recipients.bcc,
      bodyText: body,
    },
    activeAssets,
    snapshot.phase === "editing" && Boolean(mailbox && action),
  );
  const submission = useReplySubmission({
    session,
    phase: snapshot.phase,
    mailbox,
    parent,
    action,
    recipients,
    body,
    uploadLimitError,
    uploadsPending,
    uploadsFailed,
    onSuccess: (result) => {
      setBody(initialBody);
      setBcc(EMPTY_RECIPIENT_FIELD);
      onSent(result);
    },
  });
  const busy = submission.busy;
  const linkedIds = snapshot.linkedAssetIds;
  const toAddresses = new Set(
    (action?.to ?? []).map(normalizeExternalEmailAddress),
  );
  const ccExcludedAddresses = new Set([
    ...toAddresses,
    ...recipientAddressSet(bcc),
  ]);
  const bccExcludedAddresses = new Set([
    ...toAddresses,
    ...recipientAddressSet(cc),
  ]);

  if (!mailbox?.canSend || !action || action.to.length === 0) return null;

  function selectAction(next: ReplyAction) {
    onModeChange(next.mode);
    setCc(recipientField(next.cc));
    setShowCc(next.cc.length > 0);
  }

  function handleDrop(event: DragEvent<HTMLFormElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    if (busy) return;
    session.addFiles(Array.from(event.dataTransfer.files), "attachment");
  }

  return (
    <div className="sticky bottom-16 z-20 -mx-3 bg-gradient-to-t from-background via-background to-transparent px-3 pt-10 pb-4 sm:-mx-6 sm:px-6 sm:pb-6 lg:bottom-0">
      <form
        className="mx-auto max-w-2xl animate-rise overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
        aria-busy={busy}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = busy ? "none" : "copy";
        }}
        onDrop={handleDrop}
        onSubmit={(event) => {
          event.preventDefault();
          void submission.submit();
        }}
      >
        <div className="flex min-h-11 items-center gap-2 border-b border-border/70 bg-surface-sunken/70 px-2.5">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={(
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  disabled={busy}
                />
              )}
            >
              <ReplyActionIcon mode={action.mode} />
              {action.label}
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Recipients from this message</DropdownMenuLabel>
                {parent.replyPlan.actions.map((candidate) => (
                  <DropdownMenuItem
                    key={candidate.mode}
                    disabled={busy}
                    onClick={() => selectAction(candidate)}
                  >
                    <ReplyActionIcon mode={candidate.mode} />
                    <span className="min-w-0 flex-1">
                      <span className="block">{candidate.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[...candidate.to, ...candidate.cc].join(", ")}
                      </span>
                    </span>
                    {candidate.mode === mode && <Check />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {action.mode === "reply_all" && (
            <Badge variant="secondary">
              {recipients.to.length + recipients.cc.length} people
            </Badge>
          )}
          <div className="ml-auto flex items-center">
            <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => setShowCc(true)}>Cc</Button>
            <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => setShowBcc(true)}>Bcc</Button>
          </div>
        </div>

        <div className="truncate border-b border-border/70 px-3.5 py-2 text-xs text-muted-foreground">
          Replying to <span className="font-semibold text-foreground">{parent.fromName || parent.fromAddress}</span>
          <span aria-hidden="true"> · </span>{parent.preview}
        </div>

        {showCc && (
          <div className="border-b border-border/70 px-3">
            <RecipientCombobox
              mailboxId={mailbox.id}
              label="Cc"
              value={cc}
              excludedAddresses={ccExcludedAddresses}
              disabled={busy}
              onChange={setCc}
            />
          </div>
        )}
        {showBcc && (
          <div className="border-b border-border/70 px-3">
            <RecipientCombobox
              mailboxId={mailbox.id}
              label="Bcc"
              value={bcc}
              excludedAddresses={bccExcludedAddresses}
              disabled={busy}
              onChange={setBcc}
            />
          </div>
        )}

        <InputGroup className="min-h-24 rounded-none border-0 bg-transparent shadow-none dark:bg-transparent">
          <InputGroupTextarea
            className="min-h-16 px-4 pt-3.5 text-[0.9375rem] leading-[1.65]"
            value={body}
            disabled={busy}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (
                !busy
                && (event.metaKey || event.ctrlKey)
                && event.key === "Enter"
                && (body.trim() || activeAssets.length > 0)
              ) {
                event.preventDefault();
                void submission.submit();
              }
            }}
            placeholder={action.mode === "reply_all" ? "Reply to everyone" : `Reply to ${action.to.join(", ")}`}
          />
          <InputGroupAddon align="block-end" className="border-t border-border/70 bg-surface-sunken/40 px-2.5 py-2">
            <input
              ref={fileInput}
              className="sr-only"
              type="file"
              multiple
              disabled={busy}
              onChange={(event) => {
                session.addFiles(
                  Array.from(event.target.files ?? []),
                  "attachment",
                );
                event.target.value = "";
              }}
            />
            <InputGroupButton
              size="icon-sm"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip /><span className="sr-only">Add attachments</span>
            </InputGroupButton>
            <InputGroupText
              className={cn(
                "min-w-0 flex-1 text-xs",
                (uploadLimitError || snapshot.planError) && "text-destructive",
              )}
            >
              {uploadLimitError
                ? uploadLimitError
                : activeAssets.length > 0 && snapshot.planError
                ? "Could not check attachment delivery"
                : activeAssets.length
                ? `${activeAssets.length} attachment${activeAssets.length === 1 ? "" : "s"}`
                : "Ctrl + Enter to send"}
            </InputGroupText>
            <Button
              type="submit"
              size="sm"
              disabled={
                busy
                || Boolean(uploadLimitError)
                || uploadsPending
                || uploadsFailed
              }
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <Send />}
              Send
            </Button>
          </InputGroupAddon>
        </InputGroup>

        <ComposerAttachmentList
          uploads={activeAssets}
          linkedIds={linkedIds}
          progress={session.progress}
          disabled={busy}
          onRemove={(asset) => session.remove(asset.id)}
          onRetry={(asset) => void session.retry(asset.id)}
        />
      </form>
    </div>
  );
}

function findAction(parent: MessageDetail, requestedMode: ReplyActionMode) {
  return parent.replyPlan.actions.find((action) => action.mode === requestedMode)
    ?? parent.replyPlan.actions.find((action) => action.mode === parent.replyPlan.defaultMode)
    ?? parent.replyPlan.actions[0]!;
}

export function ReplyActionIcon({ mode }: { mode: ReplyActionMode }) {
  if (mode === "reply_all") return <ReplyAll />;
  if (mode === "reply_list") return <Users />;
  if (mode === "continue") return <Send />;
  return <Reply />;
}
