import {
  Badge,
  Button,
  useConfirm,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  useAuth,
} from "@open-workspace/core/ui";
import {
  Check,
  ChevronDown,
  LoaderCircle,
  Paperclip,
  Reply,
  ReplyAll,
  Send,
  Users,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";

import { normalizeExternalEmailAddress } from "../../shared/mail";
import { ComposerAttachmentList } from "./composer-attachment-list";
import { ComposerEditor } from "./composer-editor";
import type { ComposerContent, ComposerEditorHandle } from "./composer-editor";
import {
  recipientsWithPendingInput,
  validateComposerRecipients,
} from "./composer-recipients";
import type { RecipientFieldValue } from "./composer-recipients";
import { useComposerSession } from "./composer-session";
import { RecipientCombobox } from "./recipient-combobox";
import { ReplyToWarning } from "./reply-to-warning";
import { messageSignatureHtml } from "./signature";
import type {
  Mailbox,
  MessageDetail,
  ReplyAction,
  ReplyActionMode,
} from "./types";
import { useComposerAttachmentPreflight } from "./use-composer-attachment-preflight";
import { useReplySubmission } from "./use-reply-submission";
import type { SentReply } from "./use-reply-submission";

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
  return recipientsWithPendingInput(value).map(
    (recipient) => recipient.address
  );
}

function recipientAddressSet(value: RecipientFieldValue) {
  return new Set(recipientAddresses(value).map(normalizeExternalEmailAddress));
}

const EMPTY_CONTENT: ComposerContent = {
  bodyHtml: "",
  bodyText: "",
  inlineAssetIds: [],
  linkedAssetIds: [],
  storedImages: [],
};

export function ConversationReply({
  mailbox,
  parent,
  mode,
  onModeChange,
  onCancel,
  onSent,
}: {
  mailbox?: Mailbox;
  parent: MessageDetail;
  mode: ReplyActionMode;
  onModeChange: (mode: ReplyActionMode) => void;
  onCancel: () => void;
  onSent: (result: SentReply) => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const editor = useRef<ComposerEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inlineFileInput = useRef<HTMLInputElement>(null);
  const initialAction = findAction(parent, mode);
  const fieldsSource = `${mode}\0${parent.id}`;
  const { user } = useAuth();

  // The signature that applies, as editable content above the quoted text
  // the Worker adds; the box opens empty, so it is only ever added once.
  // oxlint-disable-next-line react/hook-use-state -- read once, when the editor is created; nothing sets it
  const [initialHtml] = useState(() =>
    mailbox ? messageSignatureHtml(mailbox, "reply", user?.name ?? "") : ""
  );

  // Updated as the person edits; untouched until then.
  const [content, setContent] = useState<ComposerContent>(EMPTY_CONTENT);
  const [documentAssetIds, setDocumentAssetIds] = useState<string[]>([]);
  const [cc, setCc] = useState(() => recipientField(initialAction?.cc ?? []));
  const [bcc, setBcc] = useState<RecipientFieldValue>(EMPTY_RECIPIENT_FIELD);
  const [showCc, setShowCc] = useState(Boolean(initialAction?.cc.length));
  const [showBcc, setShowBcc] = useState(false);
  const [ccSource, setCcSource] = useState(fieldsSource);

  // Another reply mode or parent message resets Cc to its own; adjusted
  // while rendering, so the old Cc never shows with the new reply.
  if (ccSource !== fieldsSource) {
    setCcSource(fieldsSource);
    setCc(recipientField(initialAction?.cc ?? []));
    setShowCc(Boolean(initialAction?.cc.length));
  }

  const { session, snapshot } = useComposerSession(mailbox?.id ?? "");

  // Attachments, and the inline images still in the text.
  const activeAssets = snapshot.assets.filter(
    (asset) =>
      asset.intent === "attachment" || documentAssetIds.includes(asset.id)
  );

  const uploadLimitError = session.limitError();

  const uploadsPending = activeAssets.some(
    (asset) => asset.status === "uploading"
  );

  const uploadsFailed = activeAssets.some((asset) => asset.status === "error");
  const action = useMemo(() => findAction(parent, mode), [mode, parent]);

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
      bodyText: content.bodyText,
      bodyHtml: content.bodyHtml || undefined,
    },
    activeAssets,
    snapshot.phase === "editing" && Boolean(mailbox && action)
  );

  const submission = useReplySubmission({
    session,
    phase: snapshot.phase,
    mailbox,
    parent,
    action,
    recipients,
    editor,
    activeAssets,
    uploadLimitError,
    uploadsPending,
    uploadsFailed,
    onSuccess: (result) => {
      setBcc(EMPTY_RECIPIENT_FIELD);
      onSent(result);
    },
  });

  const { busy } = submission;
  const { confirm, dialog: confirmDialog } = useConfirm();
  const linkedIds = snapshot.linkedAssetIds;

  const toAddresses = new Set(
    (action?.to ?? []).map(normalizeExternalEmailAddress)
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

  async function cancel() {
    if (
      (content.bodyText.trim() || activeAssets.length > 0) &&
      !(await confirm({
        title: "Discard this reply?",
        description:
          activeAssets.length > 0
            ? "The text you wrote and its attachments are deleted."
            : "The text you wrote is deleted.",
        action: "Discard reply",
        destructive: true,
      }))
    ) {
      return;
    }

    onCancel();
  }

  function handleDrop(event: DragEvent<HTMLFormElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();

    if (busy) return;
    session.addFiles(Array.from(event.dataTransfer.files), "attachment");
  }

  return (
    <div>
      {confirmDialog}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- files can be dropped anywhere on the form */}
      <form
        ref={form}
        className="animate-rise border-input bg-surface focus-within:border-ring/60 focus-within:ring-ring/12 overflow-hidden rounded-lg border shadow-sm transition-shadow focus-within:ring-3"
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
        <div className="border-border flex min-h-10 items-center gap-2 border-b px-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  disabled={busy}
                />
              }
            >
              <ReplyActionIcon mode={action.mode} />
              {action.label}
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-80 max-w-[calc(100vw-2rem)]"
            >
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  Recipients from this message
                </DropdownMenuLabel>
                {parent.replyPlan.actions.map((candidate) => (
                  <DropdownMenuItem
                    key={candidate.mode}
                    disabled={busy}
                    onClick={() => selectAction(candidate)}
                  >
                    <ReplyActionIcon mode={candidate.mode} />
                    <span className="min-w-0 flex-1">
                      <span className="block">{candidate.label}</span>
                      <span className="text-muted-foreground block truncate text-xs">
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
            {!showCc && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                disabled={busy}
                onClick={() => setShowCc(true)}
              >
                Cc
              </Button>
            )}
            {!showBcc && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                disabled={busy}
                onClick={() => setShowBcc(true)}
              >
                Bcc
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground ml-1"
              aria-label="Discard reply"
              disabled={busy}
              onClick={cancel}
            >
              <X />
            </Button>
          </div>
        </div>

        <div className="border-border text-muted-foreground truncate border-b px-3.5 py-2 text-xs">
          Replying to{" "}
          <span className="text-foreground font-semibold">
            {parent.fromName || parent.fromAddress}
          </span>
          <span aria-hidden="true"> · </span>
          {parent.preview}
        </div>
        <ReplyToWarning
          message={parent}
          recipients={[...recipients.to, ...recipients.cc, ...recipients.bcc]}
          className="border-border border-b"
        />

        {showCc && (
          <div className="border-border border-b px-3">
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
          <div className="border-border border-b px-3">
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

        <div className="flex h-64 flex-col">
          <ComposerEditor
            ref={editor}
            session={session}
            initialHtml={initialHtml}
            label="Reply"
            placeholder={
              action.mode === "reply_all"
                ? "Reply to everyone"
                : `Reply to ${action.to.join(", ")}`
            }
            onChange={setContent}
            onAssetsChange={setDocumentAssetIds}
            onAddInlineFiles={(files, position) => {
              const assets = session.addFiles(files, "inline");

              if (assets) editor.current?.insertAssets(assets, position);
            }}
            onAddAttachmentFiles={(files) => {
              session.addFiles(files, "attachment");
            }}
            onChooseInlineImage={() => inlineFileInput.current?.click()}
            onSubmitShortcut={() => form.current?.requestSubmit()}
            dragging={false}
            disabled={busy}
          />
        </div>
        <div className="border-border text-muted-foreground flex items-center gap-2 border-t px-2 py-1.5 text-sm">
          <input
            ref={fileInput}
            className="sr-only"
            type="file"
            multiple
            disabled={busy}
            onChange={(event) => {
              session.addFiles(
                Array.from(event.target.files ?? []),
                "attachment"
              );
              event.target.value = "";
            }}
          />
          <input
            ref={inlineFileInput}
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            tabIndex={-1}
            aria-hidden
            disabled={busy}
            onChange={(event) => {
              const assets = session.addFiles(
                Array.from(event.target.files ?? []),
                "inline"
              );

              if (assets) editor.current?.insertAssets(assets);
              event.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip />
            <span className="sr-only">Add attachments</span>
          </Button>
          <span
            className={cn(
              "min-w-0 flex-1 text-xs",
              (uploadLimitError || snapshot.planError) && "text-destructive"
            )}
          >
            {uploadLimitError ||
              (activeAssets.length > 0 && snapshot.planError ? (
                "Could not check attachment delivery"
              ) : activeAssets.length ? (
                `${activeAssets.length} attachment${activeAssets.length === 1 ? "" : "s"}`
              ) : (
                <span className="hidden sm:inline">Ctrl + Enter to send</span>
              ))}
          </span>
          <Button
            type="submit"
            size="sm"
            disabled={
              busy ||
              Boolean(uploadLimitError) ||
              uploadsPending ||
              uploadsFailed
            }
          >
            {busy ? <LoaderCircle className="animate-spin" /> : <Send />}
            Send
          </Button>
        </div>

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

/** The plan's action for the mode, else its default; none for an empty plan. */
function findAction(parent: MessageDetail, requestedMode: ReplyActionMode) {
  return (
    parent.replyPlan.actions.find((action) => action.mode === requestedMode) ??
    parent.replyPlan.actions.find(
      (action) => action.mode === parent.replyPlan.defaultMode
    ) ??
    parent.replyPlan.actions[0]
  );
}

export function ReplyActionIcon({ mode }: { mode: ReplyActionMode }) {
  if (mode === "reply_all") return <ReplyAll />;

  if (mode === "reply_list") return <Users />;

  if (mode === "continue") return <Send />;

  return <Reply />;
}
