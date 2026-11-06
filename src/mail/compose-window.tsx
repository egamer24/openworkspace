import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { toast } from "sonner";
import {
  forwardSubject,
} from "../../shared/mail";
import { ComposerAttachmentList } from "./composer-attachment-list";
import {
  ComposerEditor,
  type ComposerContent,
  type ComposerEditorHandle,
} from "./composer-editor";
import { ComposerRecipientFields } from "./composer-recipient-fields";
import {
  validateComposerRecipients,
  type RecipientFieldValue,
} from "./composer-recipients";
import type { Mailbox, MessageDetail } from "./types";
import {
  useComposerSession,
} from "./composer-session";
import { isInlineComposerImage } from "./composer-upload-client";
import { useComposerAttachmentPreflight } from "./use-composer-attachment-preflight";
import {
  ComposeWindowFooter,
  ComposeWindowHeader,
  ForwardedMessageNotice,
  MinimizedComposer,
} from "./compose-window-chrome";
import { useComposeSubmission } from "./use-compose-submission";
import {
  draftAssets,
  draftAttachments,
  useDraftAutosave,
  type SavedDraft,
} from "./use-draft-autosave";
import { recipientsWithPendingInput } from "./composer-recipients";

function recipientField(addresses: readonly string[] = []): RecipientFieldValue {
  return {
    recipients: addresses.map((address) => ({ address, name: null })),
    input: "",
  };
}

function addresses(value: RecipientFieldValue) {
  return recipientsWithPendingInput(value).map((recipient) => recipient.address);
}

const EMPTY_RECIPIENT_FIELD: RecipientFieldValue = {
  recipients: [],
  input: "",
};

const EMPTY_CONTENT: ComposerContent = {
  bodyHtml: "",
  bodyText: "",
  inlineAssetIds: [],
  linkedAssetIds: [],
};

export function ComposeWindow({
  mailbox,
  forwardedMessage,
  draft,
  onClose,
}: {
  mailbox: Mailbox;
  forwardedMessage?: Pick<
    MessageDetail,
    | "id"
    | "conversationId"
    | "subject"
    | "fromAddress"
    | "fromName"
    | "preview"
    | "attachments"
  >;
  /** A saved draft to reopen. */
  draft?: SavedDraft;
  onClose: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const editor = useRef<ComposerEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inlineFileInput = useRef<HTMLInputElement>(null);
  const [to, setTo] = useState<RecipientFieldValue>(
    () => draft ? recipientField(draft.toJson) : EMPTY_RECIPIENT_FIELD,
  );
  const [cc, setCc] = useState<RecipientFieldValue>(
    () => draft ? recipientField(draft.ccJson) : EMPTY_RECIPIENT_FIELD,
  );
  const [bcc, setBcc] = useState<RecipientFieldValue>(
    () => draft ? recipientField(draft.bccJson) : EMPTY_RECIPIENT_FIELD,
  );
  const [replyTo, setReplyTo] = useState(draft?.replyTo ?? "");
  const [subject, setSubject] = useState(
    () => draft?.subject
      ?? (forwardedMessage ? forwardSubject(forwardedMessage.subject) : ""),
  );
  const [content, setContent] = useState<ComposerContent>(EMPTY_CONTENT);
  const [documentAssetIds, setDocumentAssetIds] = useState<string[]>([]);
  const [minimized, setMinimized] = useState(false);
  const [dragging, setDragging] = useState(false);
  const { session, snapshot } = useComposerSession(
    mailbox.id,
    forwardedMessage?.attachments,
    draft ? draftAssets(mailbox.id, draft) : [],
  );

  const recipients = validateComposerRecipients({
    to,
    cc,
    bcc,
    replyTo,
  });
  const recipientCount = recipients.count;
  const documentAssetIdSet = useMemo(
    () => new Set(documentAssetIds),
    [documentAssetIds],
  );
  const activeAssets = useMemo(
    () => snapshot.assets.filter((asset) => documentAssetIdSet.has(asset.id)),
    [documentAssetIdSet, snapshot.assets],
  );
  useComposerAttachmentPreflight(
    session,
    forwardedMessage
      ? {
          kind: "forward",
          mailboxId: mailbox.id,
          sourceEmailId: forwardedMessage.id,
          bodyText: content.bodyText,
          bodyHtml: content.bodyHtml || undefined,
        }
      : {
          kind: "compose",
          mailboxId: mailbox.id,
          subject,
          bodyText: content.bodyText,
          bodyHtml: content.bodyHtml || undefined,
    },
    activeAssets,
    snapshot.phase === "editing",
  );
  const linkedIds = snapshot.linkedAssetIds;
  const attachmentError = session.limitError();
  const uploadsPending = activeAssets.some(
    (asset) => asset.status === "uploading",
  );
  const uploadsFailed = activeAssets.some(
    (asset) => asset.status === "error",
  );
  const autosave = useDraftAutosave({
    mailboxId: mailbox.id,
    session,
    restored: draft,
    enabled: snapshot.phase === "editing" && mailbox.canSend,
    changeKey: JSON.stringify([
      addresses(to),
      addresses(cc),
      addresses(bcc),
      replyTo,
      subject,
      content.bodyHtml,
      draftAttachments(activeAssets),
    ]),
    buildPayload: () => ({
      kind: forwardedMessage ? "forward" : "compose",
      sourceMessageId: forwardedMessage?.id ?? null,
      conversationId: forwardedMessage?.conversationId ?? null,
      to: addresses(to),
      cc: addresses(cc),
      bcc: addresses(bcc),
      replyTo: replyTo.trim() || null,
      subject,
      editorBody: editor.current?.html() ?? "",
      bodyText: editor.current?.content().bodyText ?? content.bodyText,
      attachments: draftAttachments(activeAssets),
    }),
  });
  const submission = useComposeSubmission({
    session,
    phase: snapshot.phase,
    mailbox,
    forwardedMessage,
    recipients,
    subject,
    content,
    editor,
    activeAssets,
    uploadLimitError: attachmentError,
    uploadsPending,
    uploadsFailed,
    draftId: autosave.draftId,
    onClose,
  });
  const busy = submission.busy;

  useEffect(() => {
    if (busy) setDragging(false);
  }, [busy]);

  function addInlineFiles(files: File[], position?: number) {
    const assets = session.addFiles(files, "inline");
    if (!assets) return;
    editor.current?.insertAssets(assets, position);
  }

  function addAttachmentFiles(files: File[], position?: number) {
    const assets = session.addFiles(files, "attachment");
    if (!assets) return;
    editor.current?.insertAssets(assets, position);
  }

  function handleComposerDrop(event: DragEvent<HTMLFormElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDragging(false);
    if (busy) return;

    // ProseMirror owns editor-body drops so it can preserve the insertion
    // position. The form catches files dropped on every other composer area.
    if (
      event.target instanceof Element
      && event.target.closest("[data-composer-editor-content]")
    ) {
      return;
    }

    const inline: File[] = [];
    const attachments: File[] = [];
    for (const file of Array.from(event.dataTransfer.files)) {
      (isInlineComposerImage(file) ? inline : attachments).push(file);
    }
    if (inline.length) addInlineFiles(inline);
    if (attachments.length) addAttachmentFiles(attachments);
  }

  async function closeComposer() {
    if (busy) {
      toast.error("Wait for the message to finish sending");
      return;
    }
    // A saved draft keeps its uploads; closing must not discard them.
    if (await autosave.flush()) session.retainAll();
    session.close();
    onClose();
  }

  async function discardComposer() {
    if (busy) {
      toast.error("Wait for the message to finish sending");
      return;
    }
    try {
      await autosave.discard();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Draft could not be discarded");
      return;
    }
    session.close();
    onClose();
  }

  if (minimized) {
    return (
      <MinimizedComposer
        subject={subject}
        onRestore={() => setMinimized(false)}
        onClose={() => void closeComposer()}
      />
    );
  }

  return (
    <section
      role="dialog"
      aria-label="New message"
      className="fixed inset-0 z-50 flex animate-rise flex-col bg-surface shadow-2xl ring-1 ring-border sm:inset-auto sm:right-5 sm:bottom-5 sm:h-[min(600px,calc(100dvh-2.5rem))] sm:w-[min(560px,calc(100vw-2.5rem))] sm:rounded-xl"
    >
      <form
        ref={form}
        className="flex min-h-0 flex-1 flex-col"
        aria-busy={busy}
        onSubmit={submission.submit}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = busy ? "none" : "copy";
        }}
        onDragLeave={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setDragging(false);
          }
        }}
        onDragEnd={() => setDragging(false)}
        onDrop={handleComposerDrop}
      >
        <ComposeWindowHeader
          from={mailbox.address}
          onMinimize={() => setMinimized(true)}
          onDiscard={() => void discardComposer()}
          onClose={() => void closeComposer()}
        />

        <ComposerRecipientFields
          mailboxId={mailbox.id}
          to={to}
          cc={cc}
          bcc={bcc}
          replyTo={replyTo}
          subject={subject}
          subjectReadOnly={Boolean(forwardedMessage)}
          disabled={busy}
          onToChange={setTo}
          onCcChange={setCc}
          onBccChange={setBcc}
          onReplyToChange={setReplyTo}
          onSubjectChange={setSubject}
        />

        {forwardedMessage ? (
          <ForwardedMessageNotice message={forwardedMessage} />
        ) : null}

        <ComposerEditor
          ref={editor}
          session={session}
          onChange={setContent}
          onAssetsChange={setDocumentAssetIds}
          onAddInlineFiles={(files, position) => {
            addInlineFiles(files, position);
          }}
          onAddAttachmentFiles={(files, position) => {
            addAttachmentFiles(files, position);
          }}
          onChooseInlineImage={() => inlineFileInput.current?.click()}
          onSubmitShortcut={() => form.current?.requestSubmit()}
          dragging={dragging}
          disabled={busy}
          initialHtml={draft?.editorBody}
          initialAttachments={draft
            ? session.getSnapshot().assets.filter((asset) => asset.intent === "attachment")
            : undefined}
        />

        <ComposerAttachmentList
          uploads={activeAssets.filter(
            (asset) =>
              !linkedIds.has(asset.id)
              || asset.status !== "uploaded",
          )}
          linkedIds={linkedIds}
          progress={session.progress}
          disabled={busy}
          onRemove={(asset) => {
            if (editor.current?.removeAsset(asset.id)) return;
            session.remove(asset.id);
          }}
          onRetry={(asset) => {
            void session.retry(asset.id);
          }}
        />

        <ComposeWindowFooter
          fileInput={fileInput}
          inlineFileInput={inlineFileInput}
          uploads={activeAssets}
          error={
            attachmentError
            ?? (activeAssets.length > 0 && snapshot.planError
              ? "Could not check attachment delivery"
              : null)
          }
          sending={busy}
          sendDisabled={
            busy
            || recipientCount === 0
            || !mailbox.canSend
            || Boolean(attachmentError)
            || uploadsPending
            || uploadsFailed
          }
          onAddAttachments={addAttachmentFiles}
          onAddInlineImages={(files) => {
            addInlineFiles(files);
          }}
        />
      </form>
    </section>
  );
}
