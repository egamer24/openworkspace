import { useAuth, useConfirm } from "@open-workspace/core/ui";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { DragEvent, RefObject } from "react";
import { toast } from "sonner";

import { forwardSubject } from "../../shared/mail";
import {
  ComposeWindowFooter,
  ComposeWindowHeader,
  ForwardedMessageNotice,
  MinimizedComposer,
} from "./compose-window-chrome";
import { ComposerAttachmentList } from "./composer-attachment-list";
import { ComposerEditor } from "./composer-editor";
import type { ComposerContent, ComposerEditorHandle } from "./composer-editor";
import { ComposerRecipientFields } from "./composer-recipient-fields";
import {
  recipientAddresses,
  recipientField,
  validateComposerRecipients,
} from "./composer-recipients";
import type { RecipientFieldValue } from "./composer-recipients";
import { useComposerSession } from "./composer-session";
import { isInlineComposerImage } from "./composer-upload-client";
import {
  draftAttachments,
  holdsOnlyInitialContent,
  openingText,
  restoredComposerAssets,
  restoredDraftHtml,
} from "./draft-attachments";
import { ReplyToWarning } from "./reply-to-warning";
import { messageSignatureHtml } from "./signature";
import type { Mailbox, MessageDetail } from "./types";
import { useComposeSubmission } from "./use-compose-submission";
import { useComposerAttachmentPreflight } from "./use-composer-attachment-preflight";
import { useDraftAutosave } from "./use-drafts";
import type { DraftContent, SavedDraft } from "./use-drafts";

const EMPTY_RECIPIENT_FIELD: RecipientFieldValue = {
  recipients: [],
  input: "",
};

const EMPTY_CONTENT: ComposerContent = {
  bodyHtml: "",
  editorHtml: "",
  bodyText: "",
  inlineAssetIds: [],
  storedImages: [],
  linkedAssetIds: [],
};

/** Below Tailwind's `sm`, the composer covers the screen. */
const PHONE_QUERY = "(max-width: 639.98px)";

function usePhoneLayout() {
  return useSyncExternalStore(
    (onChange) => {
      const media = matchMedia(PHONE_QUERY);
      media.addEventListener("change", onChange);

      return () => media.removeEventListener("change", onChange);
    },
    () => matchMedia(PHONE_QUERY).matches,
    () => false
  );
}

/**
 * Makes everything outside `element` inert: each sibling of the element and
 * of its ancestors up to <body>. Returns the undo. Elements that were inert
 * already are left alone.
 */
function inertOutside(element: HTMLElement) {
  const changed: HTMLElement[] = [];

  for (
    let node: HTMLElement | null = element;
    node && node !== document.body;
    node = node.parentElement
  ) {
    for (const sibling of node.parentElement?.children ?? []) {
      if (
        sibling === node ||
        !(sibling instanceof HTMLElement) ||
        sibling.inert
      ) {
        continue;
      }

      if (
        sibling instanceof HTMLScriptElement ||
        sibling instanceof HTMLStyleElement
      ) {
        continue;
      }

      sibling.inert = true;
      changed.push(sibling);
    }
  }

  return () => {
    for (const sibling of changed) sibling.inert = false;
  };
}

/**
 * On a phone the composer is a full-screen modal: the page behind is inert,
 * focus starts inside, Escape closes it (unless a list or popup inside is
 * open and takes the key), and focus goes back to what opened it. The
 * floating desktop window stays non-modal.
 */
function useFullScreenComposer(
  section: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape: () => void
) {
  const escape = useEffectEvent(onEscape);
  // What had focus before the composer opened, to go back to when it closes.
  const opener = useRef(document.activeElement);
  useEffect(() => {
    const element = section.current;

    if (!active || !element) return;
    const undo = inertOutside(element);

    if (!element.contains(document.activeElement)) element.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;

      if (
        event.target instanceof Element &&
        event.target.closest('[aria-expanded="true"]')
      ) {
        return;
      }

      event.preventDefault();
      escape();
    };

    element.addEventListener("keydown", onKeyDown);

    return () => {
      element.removeEventListener("keydown", onKeyDown);
      undo();
      // Once the composer is gone, focus would fall to <body>.
      const { current: returnTo } = opener;

      requestAnimationFrame(() => {
        const current = document.activeElement;

        if (
          (!current || current === document.body) &&
          returnTo instanceof HTMLElement &&
          returnTo.isConnected
        ) {
          returnTo.focus();
        }
      });
    };
  }, [section, active]);
}

export function ComposeWindow({
  mailbox,
  forwardedMessage,
  draft,
  draftId,
  onSaved,
  onClose,
}: {
  mailbox: Mailbox;
  forwardedMessage?: Pick<
    MessageDetail,
    | "id"
    | "subject"
    | "fromAddress"
    | "fromName"
    | "preview"
    | "attachments"
    | "security"
    | "conversationId"
  >;
  /** A saved draft to reopen. */
  draft?: SavedDraft;
  /** The id this composer's draft is saved under. */
  draftId: string;
  /** The draft was first saved. */
  onSaved: (draftId: string) => void;
  onClose: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const editor = useRef<ComposerEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inlineFileInput = useRef<HTMLInputElement>(null);

  const [to, setTo] = useState<RecipientFieldValue>(() =>
    draft ? recipientField(draft.to) : EMPTY_RECIPIENT_FIELD
  );

  const [cc, setCc] = useState<RecipientFieldValue>(() =>
    draft ? recipientField(draft.cc) : EMPTY_RECIPIENT_FIELD
  );

  const [bcc, setBcc] = useState<RecipientFieldValue>(() =>
    draft ? recipientField(draft.bcc) : EMPTY_RECIPIENT_FIELD
  );

  const [replyTo, setReplyTo] = useState(draft?.replyTo ?? "");

  const [subject, setSubject] = useState(
    () =>
      draft?.subject ??
      (forwardedMessage ? forwardSubject(forwardedMessage.subject) : "")
  );

  const [content, setContent] = useState<ComposerContent>(() =>
    draft
      ? {
          ...EMPTY_CONTENT,
          bodyHtml: draft.bodyHtml ?? "",
          editorHtml: draft.editorHtml ?? draft.bodyHtml ?? "",
          bodyText: draft.bodyText,
        }
      : EMPTY_CONTENT
  );

  const [documentAssetIds, setDocumentAssetIds] = useState<string[]>([]);
  const [minimized, setMinimized] = useState(false);
  const [dragging, setDragging] = useState(false);
  const section = useRef<HTMLElement>(null);
  const minimizeButton = useRef<HTMLButtonElement>(null);
  const restoreButton = useRef<HTMLButtonElement>(null);
  // Minimizing moves focus to Restore, and restoring back to Minimize.
  const focusAfterToggle = useRef(false);
  const phone = usePhoneLayout();

  const { session, snapshot } = useComposerSession(
    mailbox.id,
    forwardedMessage?.attachments,
    restoredComposerAssets(mailbox.id, draft)
  );

  const { user } = useAuth();

  // A reopened draft as it was saved; otherwise the signature that applies,
  // as editable content. Either way it is added once, so a reopened draft
  // never gets a second signature.
  // oxlint-disable-next-line react/hook-use-state -- read once, when the editor is created; nothing sets it
  const [initialHtml] = useState(() =>
    draft
      ? restoredDraftHtml(draft)
      : messageSignatureHtml(
          mailbox,
          forwardedMessage ? "reply" : "new",
          user?.name ?? ""
        )
  );

  // The text the editor opened with: a new composer still holding just that
  // (its signature) is untouched and creates no draft.
  // oxlint-disable-next-line react/hook-use-state -- read once; nothing sets it
  const [initialText] = useState(() => openingText(initialHtml));

  const recipients = validateComposerRecipients({
    to,
    cc,
    bcc,
    replyTo,
  });

  const recipientCount = recipients.count;

  const documentAssetIdSet = useMemo(
    () => new Set(documentAssetIds),
    [documentAssetIds]
  );

  const activeAssets = useMemo(
    () => snapshot.assets.filter((asset) => documentAssetIdSet.has(asset.id)),
    [documentAssetIdSet, snapshot.assets]
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
    snapshot.phase === "editing"
  );
  const linkedIds = snapshot.linkedAssetIds;
  const attachmentError = session.limitError();

  const uploadsPending = activeAssets.some(
    (asset) => asset.status === "uploading"
  );

  const uploadsFailed = activeAssets.some((asset) => asset.status === "error");
  const toAddresses = recipientAddresses(to);
  const ccAddresses = recipientAddresses(cc);
  const bccAddresses = recipientAddresses(bcc);

  const keptAttachments = draftAttachments(activeAssets);

  const draftContent = (body: ComposerContent): DraftContent => ({
    kind: forwardedMessage ? "forward" : "compose",
    sourceEmailId: forwardedMessage?.id ?? null,
    conversationId: forwardedMessage?.conversationId ?? null,
    to: toAddresses,
    cc: ccAddresses,
    bcc: bccAddresses,
    replyTo: replyTo.trim() || null,
    subject,
    bodyText: body.bodyText,
    bodyHtml: body.bodyHtml,
    // The editor's HTML, so the reopened editor puts the files back in place.
    editorHtml: body.editorHtml,
    attachments: keptAttachments,
    storedImages: body.storedImages,
  });

  const autosave = useDraftAutosave({
    mailboxId: mailbox.id,
    session,
    draftId,
    restored: draft,
    content: draftContent(content),
    blank: () =>
      !draft &&
      !toAddresses.length &&
      !ccAddresses.length &&
      !bccAddresses.length &&
      (Boolean(forwardedMessage) || !subject.trim()) &&
      holdsOnlyInitialContent(content, initialText, keptAttachments.length),
    editing: snapshot.phase === "editing" && mailbox.canSend,
    onSaved,
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
    // Sent: the server deleted the draft.
    onClose: () => {
      autosave.sent();
      onClose();
    },
  });

  const { confirm, dialog: confirmDialog } = useConfirm();

  const { busy } = submission;
  // Sending takes over the window: no drop target while it is busy.
  const dropTarget = dragging && !busy;

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
      event.target instanceof Element &&
      event.target.closest("[data-composer-editor-content]")
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

  function closeComposer() {
    if (busy) {
      toast.error("Wait for the message to finish sending");

      return;
    }

    // The editor reports changes after a short pause; save what it has now.
    autosave.flush(draftContent(editor.current?.content() ?? content));
    session.close();
    onClose();
  }

  async function discardDraft() {
    if (busy) return;

    if (
      !(await confirm({
        title: "Discard this draft?",
        description: "The message you wrote and its attachments are deleted.",
        action: "Discard draft",
        destructive: true,
      }))
    ) {
      return;
    }

    try {
      await autosave.discard();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not discard the draft"
      );

      return;
    }

    session.close();
    onClose();
  }

  function toggleMinimized(next: boolean) {
    focusAfterToggle.current = true;
    setMinimized(next);
  }

  useEffect(() => {
    if (!focusAfterToggle.current) return;
    focusAfterToggle.current = false;
    (minimized ? restoreButton : minimizeButton).current?.focus();
  }, [minimized]);

  useFullScreenComposer(section, phone && !minimized, closeComposer);

  if (minimized) {
    return (
      <MinimizedComposer
        subject={subject}
        restoreRef={restoreButton}
        onRestore={() => toggleMinimized(false)}
        onClose={closeComposer}
      />
    );
  }

  return (
    <section
      ref={section}
      role="dialog"
      aria-label="New message"
      aria-modal={phone || undefined}
      tabIndex={-1}
      className="animate-rise bg-surface ring-border fixed inset-0 z-50 flex flex-col shadow-2xl ring-1 outline-none sm:inset-auto sm:right-6 sm:bottom-6 sm:h-[min(600px,calc(100dvh-3rem))] sm:w-[min(560px,calc(100vw-2.5rem))] sm:rounded-xl"
    >
      {confirmDialog}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- files can be dropped anywhere on the form */}
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
            !(
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget)
            )
          ) {
            setDragging(false);
          }
        }}
        onDragEnd={() => setDragging(false)}
        onDrop={handleComposerDrop}
      >
        <ComposeWindowHeader
          from={mailbox.address}
          minimizeRef={minimizeButton}
          onMinimize={() => toggleMinimized(true)}
          onDiscard={() => void discardDraft()}
          onClose={closeComposer}
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
          <>
            <ForwardedMessageNotice message={forwardedMessage} />
            <ReplyToWarning
              message={forwardedMessage}
              recipients={[
                ...recipients.to,
                ...recipients.cc,
                ...recipients.bcc,
              ]}
            />
          </>
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
          initialHtml={initialHtml}
          dragging={dropTarget}
          disabled={busy}
        />

        <ComposerAttachmentList
          uploads={activeAssets.filter(
            (asset) => !linkedIds.has(asset.id) || asset.status !== "uploaded"
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
            attachmentError ??
            (activeAssets.length > 0 && snapshot.planError
              ? "Could not check attachment delivery"
              : null)
          }
          sending={busy}
          sendDisabled={
            busy ||
            recipientCount === 0 ||
            !mailbox.canSend ||
            Boolean(attachmentError) ||
            uploadsPending ||
            uploadsFailed
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
