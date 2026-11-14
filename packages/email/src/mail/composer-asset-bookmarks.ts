import { closeHistory } from "@tiptap/pm/history";
import { Fragment } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Step, StepResult } from "@tiptap/pm/transform";
import type { Mappable } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";

import type {
  ComposerAsset,
  ComposerAssetIntent,
  ComposerSession,
} from "./composer-session";

type AssetBookmark = {
  assetId: string;
  intent: ComposerAssetIntent;
  pos: number;
};

type BookmarkState = ReadonlyMap<string, AssetBookmark>;

/** A transaction's note to keep these assets' bookmarks though their nodes went. */
class PreserveRemoved {
  constructor(readonly assetIds: ReadonlySet<string>) {}
}

const composerAssetBookmarksKey = new PluginKey<BookmarkState>(
  "composerAssetBookmarks"
);

class AssetBookmarkStep extends Step {
  constructor(
    readonly bookmark: AssetBookmark,
    readonly add: boolean
  ) {
    super();
  }

  apply(doc: ProseMirrorNode) {
    return StepResult.ok(doc);
  }

  invert() {
    return new AssetBookmarkStep(this.bookmark, !this.add);
  }

  map(mapping: Mappable) {
    return new AssetBookmarkStep(
      {
        ...this.bookmark,
        pos: mapping.map(this.bookmark.pos, 1),
      },
      this.add
    );
  }

  toJSON() {
    return {
      stepType: "openworkspaceAssetBookmark",
      bookmark: this.bookmark,
      add: this.add,
    };
  }

  static fromJSON(
    _schema: Schema,
    value: {
      bookmark: AssetBookmark;
      add: boolean;
    }
  ) {
    return new AssetBookmarkStep(value.bookmark, value.add);
  }
}

// History keeps the Step instances in memory, while JSON registration makes
// the operation safe if ProseMirror history is serialized in the future.
try {
  Step.jsonID("openworkspaceAssetBookmark", AssetBookmarkStep);
} catch (error) {
  if (
    !(error instanceof RangeError && error.message.includes("Duplicate use"))
  ) {
    throw error;
  }
}

function visibleAssets(doc: ProseMirrorNode) {
  const result = new Map<string, AssetBookmark>();
  doc.descendants((node, pos) => {
    if (node.type.name !== "composerAsset") return;
    const assetId = String(node.attrs.assetId ?? "");
    const intent = node.attrs.intent === "inline" ? "inline" : "attachment";

    if (assetId) result.set(assetId, { assetId, intent, pos });
  });

  return result;
}

function applyBookmarkTransaction(
  transaction: Transaction,
  value: BookmarkState,
  oldState: EditorState,
  newState: EditorState
) {
  const next = new Map<string, AssetBookmark>();

  for (const bookmark of value.values()) {
    next.set(bookmark.assetId, {
      ...bookmark,
      pos: transaction.mapping.map(bookmark.pos, 1),
    });
  }

  const before = visibleAssets(oldState.doc);
  const after = visibleAssets(newState.doc);

  const meta: unknown = transaction.getMeta(composerAssetBookmarksKey);
  const preserved = meta instanceof PreserveRemoved ? meta.assetIds : null;

  for (const assetId of before.keys()) {
    if (!after.has(assetId) && !preserved?.has(assetId)) {
      next.delete(assetId);
    }
  }

  for (const bookmark of after.values()) next.set(bookmark.assetId, bookmark);

  // Explicit bookmark steps must win over the document-derived projection.
  // That lets undo remove a link card inserted by reconciliation.
  for (const step of transaction.steps) {
    if (!(step instanceof AssetBookmarkStep)) continue;

    if (step.add) next.set(step.bookmark.assetId, step.bookmark);
    else next.delete(step.bookmark.assetId);
  }

  return next;
}

function bookmarkSignature(bookmarks: BookmarkState) {
  return [...bookmarks.keys()].sort().join("\0");
}

export function reconcileComposerAssetNodes(
  view: EditorView,
  session: ComposerSession
) {
  const bookmarks = composerAssetBookmarksKey.getState(view.state);

  if (!bookmarks) return;
  const snapshot = session.getSnapshot();
  const assets = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
  const visible = visibleAssets(view.state.doc);
  const hide: { assetId: string; from: number; to: number }[] = [];
  const show: AssetBookmark[] = [];

  for (const node of visible.values()) {
    if (!bookmarks.has(node.assetId)) {
      hide.push({
        assetId: node.assetId,
        from: node.pos,
        to: node.pos + 1,
      });
    }
  }

  for (const bookmark of bookmarks.values()) {
    const asset = assets.get(bookmark.assetId);
    const node = visible.get(bookmark.assetId);

    if (!asset) {
      if (node) {
        hide.push({
          assetId: bookmark.assetId,
          from: node.pos,
          to: node.pos + 1,
        });
      }

      continue;
    }

    const shouldBeVisible =
      asset.intent === "inline" ||
      asset.status === "error" ||
      snapshot.linkedAssetIds.has(asset.id);

    if (shouldBeVisible && !node) show.push(bookmark);

    if (!shouldBeVisible && node) {
      hide.push({
        assetId: bookmark.assetId,
        from: node.pos,
        to: node.pos + 1,
      });
    }
  }

  if (!hide.length && !show.length) return;

  let transaction = view.state.tr;
  const preserved = new Set<string>();

  for (const range of hide.sort((left, right) => right.from - left.from)) {
    transaction = transaction.delete(range.from, range.to);
    preserved.add(range.assetId);
  }

  for (const bookmark of show) {
    const asset = assets.get(bookmark.assetId);

    if (!asset) continue;

    const position = Math.min(
      transaction.doc.content.size,
      transaction.mapping.map(bookmark.pos, 1)
    );

    transaction = transaction.insert(
      position,
      view.state.schema.node("composerAsset", {
        assetId: asset.id,
        intent: asset.intent,
      })
    );
  }

  if (!transaction.docChanged) return;
  view.dispatch(
    transaction
      .setMeta(composerAssetBookmarksKey, new PreserveRemoved(preserved))
      .setMeta("addToHistory", false)
  );
}

export function createComposerAssetBookmarksPlugin(
  session: ComposerSession,
  onAssetsChanged: (assetIds: string[]) => void
) {
  return new Plugin<BookmarkState>({
    key: composerAssetBookmarksKey,
    state: {
      // A reopened draft's assets: those in its HTML where they are, the
      // rest (plain attachments) at the end.
      init: (_config, state) => {
        const bookmarks = visibleAssets(state.doc);

        for (const asset of session.getSnapshot().assets) {
          if (!bookmarks.has(asset.id)) {
            bookmarks.set(asset.id, {
              assetId: asset.id,
              intent: asset.intent,
              pos: state.doc.content.size,
            });
          }
        }

        return bookmarks;
      },
      apply: applyBookmarkTransaction,
    },
    view(initialView) {
      let view = initialView;
      let destroyed = false;
      let reconcileQueued = false;
      let lastSignature = "";

      const notifyBookmarks = () => {
        const bookmarks =
          composerAssetBookmarksKey.getState(view.state) ?? new Map();

        const signature = bookmarkSignature(bookmarks);

        if (signature === lastSignature) return false;
        lastSignature = signature;
        onAssetsChanged([...bookmarks.keys()]);

        return true;
      };

      const queueReconcile = () => {
        if (reconcileQueued || destroyed) return;
        reconcileQueued = true;
        queueMicrotask(() => {
          reconcileQueued = false;

          if (!destroyed) reconcileComposerAssetNodes(view, session);
        });
      };

      let sessionAssets = session.getSnapshot().assets;
      let { linkedAssetIds } = session.getSnapshot();

      const unsubscribe = session.subscribe(() => {
        const snapshot = session.getSnapshot();

        if (
          snapshot.assets === sessionAssets &&
          snapshot.linkedAssetIds === linkedAssetIds
        ) {
          return;
        }

        sessionAssets = snapshot.assets;
        linkedAssetIds = snapshot.linkedAssetIds;
        queueReconcile();
      });

      notifyBookmarks();
      queueReconcile();

      return {
        update(nextView) {
          view = nextView;

          if (notifyBookmarks()) queueReconcile();
        },
        destroy() {
          destroyed = true;
          unsubscribe();
        },
      };
    },
  });
}

export function insertComposerAssets(
  state: EditorState,
  assets: ComposerAsset[],
  position?: number
) {
  if (!assets.length) return null;

  const start = Math.min(
    position ?? state.selection.from,
    state.doc.content.size
  );

  let transaction = closeHistory(state.tr);
  let insertionPosition = start;

  for (const asset of assets) {
    if (asset.intent === "inline") {
      transaction = transaction.insert(
        insertionPosition,
        state.schema.node("composerAsset", {
          assetId: asset.id,
          intent: asset.intent,
        })
      );
      transaction = transaction.step(
        new AssetBookmarkStep(
          {
            assetId: asset.id,
            intent: asset.intent,
            pos: insertionPosition,
          },
          true
        )
      );
      insertionPosition += 1;
      continue;
    }

    transaction = transaction.step(
      new AssetBookmarkStep(
        {
          assetId: asset.id,
          intent: asset.intent,
          pos: insertionPosition,
        },
        true
      )
    );
  }

  if (assets.some((asset) => asset.intent === "inline")) {
    transaction = transaction.setSelection(
      Selection.near(
        transaction.doc.resolve(
          Math.min(insertionPosition, transaction.doc.content.size)
        ),
        1
      )
    );
  }

  return transaction;
}

export function removeComposerAsset(state: EditorState, assetId: string) {
  const visible = visibleAssets(state.doc).get(assetId);

  if (visible) {
    return closeHistory(state.tr).delete(visible.pos, visible.pos + 1);
  }

  const bookmark = composerAssetBookmarksKey.getState(state)?.get(assetId);

  return bookmark
    ? closeHistory(state.tr).step(new AssetBookmarkStep(bookmark, false))
    : null;
}

export function composerAssetIds(state: EditorState) {
  return [...(composerAssetBookmarksKey.getState(state)?.keys() ?? [])];
}

export function withoutComposerAssetNodes(fragment: Fragment): Fragment {
  const children: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (node.type.name === "composerAsset") return;
    children.push(
      node.content.size > 0
        ? node.copy(withoutComposerAssetNodes(node.content))
        : node
    );
  });

  return Fragment.fromArray(children);
}
