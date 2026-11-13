import { required } from "@open-workspace/core/shared";
import { Button, cn } from "@open-workspace/core/ui";
import { closeHistory } from "@tiptap/pm/history";
import {
  mergeAttributes,
  Node,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import { FileText, GripVertical, Link2, LoaderCircle, X } from "lucide-react";
import { useSyncExternalStore } from "react";

import { createComposerAssetBookmarksPlugin } from "./composer-asset-bookmarks";
import { linkedAttachmentPlainText } from "./composer-linked-attachment-text";
import type {
  ComposerAsset as ComposerAssetRecord,
  ComposerSession,
} from "./composer-session";
import { formatBytes } from "./format-bytes";

function LinkedAssetContent({ asset }: { asset: ComposerAssetRecord }) {
  return (
    <>
      <GripVertical
        className="text-muted-foreground/55 group-hover/composer-asset:text-muted-foreground size-3.5 shrink-0 transition-colors"
        aria-hidden
      />
      <span className="bg-info/10 text-info grid size-8 shrink-0 place-items-center rounded-md">
        <FileText className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold">
          {asset.filename}
        </span>
        <span className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-[10px]">
          <span>{formatBytes(asset.size)}</span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            {asset.status === "uploading" ? (
              <LoaderCircle className="size-2.5 animate-spin" />
            ) : (
              <Link2 className="size-2.5" />
            )}
            {asset.status === "uploading"
              ? "Uploading"
              : asset.status === "error"
                ? "Upload failed"
                : "30-day link"}
          </span>
        </span>
      </span>
    </>
  );
}

function ComposerAssetNodeView({
  editor,
  getPos,
  node,
  selected,
  session,
}: ReactNodeViewProps & { session: ComposerSession }) {
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot
  );

  const assetId = String(node.attrs.assetId ?? "");
  const asset = snapshot.assets.find((candidate) => candidate.id === assetId);

  if (!asset) {
    return <NodeViewWrapper as="span" className="hidden" />;
  }

  const linked = snapshot.linkedAssetIds.has(asset.id);

  const imageUrl =
    asset.intent === "inline" && !linked ? asset.previewUrl : null;

  const remove = () => {
    const position = getPos();

    if (position === undefined) return;
    editor.view.dispatch(
      closeHistory(editor.state.tr).delete(position, position + node.nodeSize)
    );
  };

  if (imageUrl) {
    return (
      <NodeViewWrapper
        as="span"
        data-drag-handle
        className="inline-block max-w-full align-middle"
      >
        <img
          className={cn(
            "composer-inline-image",
            selected && "outline-primary/70 outline-2"
          )}
          src={imageUrl}
          alt={asset.filename}
          title={asset.filename}
          draggable={false}
        />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      as="span"
      data-drag-handle
      data-linked-attachment-node
      role="group"
      aria-label={`${asset.filename}, linked attachment`}
      className={cn(
        "group/composer-asset border-border bg-surface-sunken/70 my-2 inline-flex min-h-12 w-full max-w-full cursor-grab items-center gap-2.5 rounded-lg border px-2.5 py-2 align-middle shadow-xs transition-[border-color,box-shadow,background-color] active:cursor-grabbing",
        "hover:border-primary/45 hover:bg-accent/45",
        selected && "border-primary/70 ring-primary/25 ring-2"
      )}
    >
      <LinkedAssetContent asset={asset} />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove ${asset.filename}`}
        contentEditable={false}
        draggable={false}
        onClick={remove}
      >
        <X />
      </Button>
    </NodeViewWrapper>
  );
}

/** The composer's session; set with `configure()` (null only until then). */
function configuredSession(session: ComposerSession | null) {
  return required(session, "ComposerAsset needs configure({ session })");
}

export const ComposerAsset = Node.create<{
  session: ComposerSession | null;
  onAssetsChanged: (assetIds: string[]) => void;
}>({
  name: "composerAsset",
  group: "inline",
  inline: true,
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return {
      session: null,
      onAssetsChanged: () => {},
    };
  },

  addAttributes() {
    return {
      assetId: { default: "", rendered: false },
      intent: { default: "attachment", rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-composer-asset]",
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) return false;

          return {
            assetId: element.dataset.composerAsset ?? "",
            intent:
              element.dataset.composerAssetIntent === "inline"
                ? "inline"
                : "attachment",
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-composer-asset": node.attrs.assetId,
        "data-composer-asset-intent": node.attrs.intent,
      }),
    ];
  },

  renderText({ node }) {
    const session = configuredSession(this.options.session);
    const asset = session.getAsset(String(node.attrs.assetId));

    if (!asset) return "";

    return session.isLinked(asset.id)
      ? linkedAttachmentPlainText(asset.uploadId, asset.filename)
      : asset.intent === "inline"
        ? asset.filename
        : "";
  },

  addNodeView() {
    const session = configuredSession(this.options.session);

    return ReactNodeViewRenderer((props) => (
      <ComposerAssetNodeView {...props} session={session} />
    ));
  },

  addProseMirrorPlugins() {
    return [
      createComposerAssetBookmarksPlugin(
        configuredSession(this.options.session),
        this.options.onAssetsChanged
      ),
    ];
  },
});
