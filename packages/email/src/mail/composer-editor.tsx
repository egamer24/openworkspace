import { cn } from "@open-workspace/core/ui";
import Placeholder from "@tiptap/extension-placeholder";
import { Slice } from "@tiptap/pm/model";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";

import { ComposerAsset } from "./composer-asset";
import {
  composerAssetIds,
  insertComposerAssets,
  reconcileComposerAssetNodes,
  removeComposerAsset,
  withoutComposerAssetNodes,
} from "./composer-asset-bookmarks";
import { composerContent } from "./composer-editor-document";
import type { ComposerContent } from "./composer-editor-document";
import type {
  ComposerAsset as ComposerAssetRecord,
  ComposerSession,
} from "./composer-session";
import { ComposerToolbar } from "./composer-toolbar";
import { isInlineComposerImage } from "./composer-upload-client";
import { StoredImage } from "./rich-content";

export type { ComposerContent } from "./composer-editor-document";

export type ComposerEditorHandle = {
  content: () => ComposerContent;
  assetIds: () => string[];
  insertAssets: (assets: ComposerAssetRecord[], position?: number) => void;
  reconcileAssets: () => void;
  removeAsset: (assetId: string) => boolean;
  focus: () => void;
};

export const ComposerEditor = forwardRef<
  ComposerEditorHandle,
  {
    session: ComposerSession;
    onChange: (content: ComposerContent) => void;
    /** Must be stable (e.g. a state setter): the editor keeps the first. */
    onAssetsChange: (assetIds: string[]) => void;
    onAddInlineFiles: (files: File[], position?: number) => void;
    onAddAttachmentFiles: (files: File[], position?: number) => void;
    onChooseInlineImage: () => void;
    onSubmitShortcut: () => void;
    dragging: boolean;
    disabled: boolean;
    /** What the editor opens with, e.g. a saved signature; read once. */
    initialHtml?: string;
    /** The editor's accessible name; read once. */
    label?: string;
    /** Read once. */
    placeholder?: string;
  }
>(function ComposerEditor(
  {
    session,
    onChange,
    onAssetsChange,
    onAddInlineFiles,
    onAddAttachmentFiles,
    onChooseInlineImage,
    onSubmitShortcut,
    dragging,
    disabled,
    initialHtml = "",
    label = "Message body",
    placeholder = "Write a message",
  },
  ref
) {
  const callbacks = useRef({
    onChange,
    onAddInlineFiles,
    onAddAttachmentFiles,
    onChooseInlineImage,
    onSubmitShortcut,
    disabled,
  });

  // The editor's handlers are created once; they read this render's props.
  useLayoutEffect(() => {
    callbacks.current = {
      onChange,
      onAddInlineFiles,
      onAddAttachmentFiles,
      onChooseInlineImage,
      onSubmitShortcut,
      disabled,
    };
  });
  const contentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        code: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        link: {
          openOnClick: false,
          defaultProtocol: "https",
        },
        strike: false,
      }),
      Placeholder.configure({ placeholder }),
      // Read once, when the editor is created: pass a stable function.
      ComposerAsset.configure({ session, onAssetsChanged: onAssetsChange }),
      StoredImage,
    ],
    content: initialHtml,
    editorProps: {
      attributes: {
        class: [
          "min-h-full px-4 py-4 text-[0.9375rem] leading-[1.65] caret-primary outline-none",
          "[&_p]:my-0 [&_p+p]:mt-3",
          "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6",
          "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6",
          "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
          "[&_a]:text-info [&_a]:underline [&_a]:underline-offset-2",
          "[&_img]:my-3 [&_img]:max-h-72 [&_img]:max-w-full [&_img]:rounded-lg [&_img]:object-contain",
          "[&_img.ProseMirror-selectednode]:outline-2 [&_img.ProseMirror-selectednode]:outline-primary/70",
          "[&_.is-editor-empty:first-child::before]:pointer-events-none [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:h-0 [&_.is-editor-empty:first-child::before]:text-muted-foreground [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
        ].join(" "),
        role: "textbox",
        "aria-label": label,
        "aria-multiline": "true",
        "data-composer-editor-content": "",
      },
      handleKeyDown: (_view, event) => {
        if (callbacks.current.disabled) return true;

        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          callbacks.current.onSubmitShortcut();

          return true;
        }

        return false;
      },
      handlePaste: (view, event, slice) => {
        if (callbacks.current.disabled) return true;
        const files = Array.from(event.clipboardData?.files ?? []);
        const images = files.filter(isInlineComposerImage);

        const attachments = files.filter(
          (file) => !isInlineComposerImage(file)
        );

        const content = withoutComposerAssetNodes(slice.content);
        const removedComposerAssets = content.size !== slice.content.size;

        if (!images.length && !attachments.length && !removedComposerAssets) {
          return false;
        }

        event.preventDefault();

        const pastedContent = new Slice(
          content,
          slice.openStart,
          slice.openEnd
        );

        if (pastedContent.content.size > 0) {
          view.dispatch(
            view.state.tr.replaceSelection(pastedContent).scrollIntoView()
          );
        }

        if (images.length) callbacks.current.onAddInlineFiles(images);

        if (attachments.length) {
          callbacks.current.onAddAttachmentFiles(attachments);
        }

        return true;
      },
      handleDrop: (view, event) => {
        if (callbacks.current.disabled) return true;
        const files = Array.from(event.dataTransfer?.files ?? []);

        if (!files.length) return false;
        event.preventDefault();
        const images: File[] = [];
        const attachments: File[] = [];

        for (const file of files) {
          (isInlineComposerImage(file) ? images : attachments).push(file);
        }

        const position = view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        })?.pos;

        if (images.length) {
          callbacks.current.onAddInlineFiles(images, position);
        }

        if (attachments.length) {
          callbacks.current.onAddAttachmentFiles(attachments, position);
        }

        return true;
      },
    },
    onUpdate: ({ editor: current }) => {
      if (contentTimer.current) clearTimeout(contentTimer.current);
      contentTimer.current = setTimeout(() => {
        callbacks.current.onChange(composerContent(current, session));
      }, 180);
    },
  });

  useEffect(() => {
    // Not an edit: no update event, so onChange only follows the person.
    editor.setEditable(!disabled, false);
  }, [disabled, editor]);

  useEffect(
    () => () => {
      if (contentTimer.current) clearTimeout(contentTimer.current);
    },
    []
  );

  useImperativeHandle(
    ref,
    () => ({
      content: () => composerContent(editor, session),
      assetIds: () => composerAssetIds(editor.state),
      insertAssets: (assets, position) => {
        const transaction = insertComposerAssets(
          editor.state,
          assets,
          position
        );

        if (!transaction) return;
        editor.view.dispatch(transaction.scrollIntoView());
        editor.commands.focus();
      },
      reconcileAssets: () => reconcileComposerAssetNodes(editor.view, session),
      removeAsset: (assetId) => {
        const transaction = removeComposerAsset(editor.state, assetId);

        if (!transaction) return false;
        editor.view.dispatch(transaction);

        return true;
      },
      focus: () => editor.commands.focus(),
    }),
    [editor, session]
  );

  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-1 flex-col overflow-hidden",
        dragging && "bg-primary/5"
      )}
    >
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-composer-editor-surface
      >
        <EditorContent
          className={cn("min-h-full", disabled && "pointer-events-none")}
          editor={editor}
        />
      </div>
      <ComposerToolbar
        editor={editor}
        onChooseInlineImage={onChooseInlineImage}
        disabled={disabled}
      />
      {dragging ? (
        <div className="border-primary/60 bg-surface/90 pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-xl border border-dashed text-sm font-medium shadow-inner">
          Drop images into the message · other files attach below
        </div>
      ) : null}
    </div>
  );
});
