import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import {
  composerAttachmentLimitError,
  EMAIL_SERVICE_MAX_BYTES,
} from "../../shared/mail";
import {
  completeComposerUpload,
  createComposerUploadIntent,
  discardComposerUpload,
  isInlineComposerImage,
  uploadComposerFile,
  uploadContentType,
} from "./composer-upload-client";
import { createComposerUploadProgressStore } from "./composer-upload-progress";

export type ComposerAssetIntent = "attachment" | "inline";

type ComposerAssetStatus = "uploading" | "uploaded" | "error";

export type ComposerAsset = {
  id: string;
  uploadId: string | null;
  filename: string;
  contentType: string;
  size: number;
  intent: ComposerAssetIntent;
  contentId: string | null;
  previewUrl: string | null;
  status: ComposerAssetStatus;
  error: string | null;
};

/** An asset whose upload finished, so it has the upload's id. */
export type UploadedComposerAsset = ComposerAsset & { uploadId: string };

export function isUploadedAsset(
  asset: ComposerAsset
): asset is UploadedComposerAsset {
  return asset.status === "uploaded" && Boolean(asset.uploadId);
}

export type SubmittedComposerUpload = {
  uploadId: string;
  disposition: ComposerAssetIntent;
  contentId?: string;
};

export type ComposerSessionPhase =
  | "editing"
  | "preflighting"
  | "submitting"
  | "closed";

export function isComposerSessionBusy(phase: ComposerSessionPhase) {
  return phase === "preflighting" || phase === "submitting";
}

type ComposerSessionSnapshot = {
  assets: readonly ComposerAsset[];
  phase: ComposerSessionPhase;
  planError: boolean;
  linkedAssetIds: ReadonlySet<string>;
};

type Listener = () => void;

const EMPTY_RESERVED_ASSETS: readonly { size: number }[] = [];
const EMPTY_LINKED_ASSETS: ReadonlySet<string> = new Set();

/**
 * Owns every attachment lifecycle transition. React and ProseMirror only read
 * projections of this state; neither keeps a second mutable upload record.
 */
export class ComposerSession {
  readonly progress = createComposerUploadProgressStore();

  private snapshot: ComposerSessionSnapshot = {
    assets: [],
    phase: "editing",
    planError: false,
    linkedAssetIds: EMPTY_LINKED_ASSETS,
  };
  private readonly listeners = new Set<Listener>();
  private readonly files = new Map<string, File>();
  private readonly requests = new Map<string, XMLHttpRequest>();
  private readonly operations = new Map<string, string>();
  private claimedAssetIds: ReadonlySet<string> = EMPTY_LINKED_ASSETS;
  private planKey: string | null = null;
  private submissionAttempt: { id: string; key: string } | null = null;
  private owners = 0;
  private disposed = false;

  /**
   * Whether closing keeps finished uploads, because a draft holds (or is
   * about to copy) them. Unkept uploads expire with `composer-uploads/`.
   */
  private retainUploads = false;

  constructor(
    readonly mailboxId: string,
    private readonly reservedAssets: readonly {
      size: number;
    }[] = EMPTY_RESERVED_ASSETS,
    /** Uploaded assets a reopened draft brings back. */
    restoredAssets: readonly ComposerAsset[] = []
  ) {
    this.snapshot = { ...this.snapshot, assets: restoredAssets };
  }

  getSnapshot = () => this.snapshot;

  setRetainUploads(retain: boolean) {
    this.retainUploads = retain;
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  };

  attach() {
    this.owners += 1;

    return () => {
      this.owners -= 1;
      queueMicrotask(() => {
        if (this.owners === 0) this.close();
      });
    };
  }

  getAsset(id: string) {
    return this.snapshot.assets.find((asset) => asset.id === id);
  }

  isLinked(id: string) {
    return this.snapshot.linkedAssetIds.has(id);
  }

  limitError() {
    return composerAttachmentLimitError([
      ...this.snapshot.assets,
      ...this.reservedAssets,
    ]);
  }

  addFiles(
    selected: Iterable<File>,
    intent: ComposerAssetIntent
  ): ComposerAsset[] | null {
    if (this.snapshot.phase !== "editing") {
      toast.error("Wait for the message to finish sending");

      return null;
    }

    const incoming = Array.from(selected);

    if (!incoming.length) return null;

    const accepted =
      intent === "inline" ? incoming.filter(isInlineComposerImage) : incoming;

    if (accepted.length !== incoming.length) {
      toast.error("Inline images must be PNG, JPEG, GIF, or WebP");
    }

    if (!accepted.length) return null;

    const limitError = composerAttachmentLimitError([
      ...this.snapshot.assets,
      ...this.reservedAssets,
      ...accepted.map((file) => ({ size: file.size })),
    ]);

    if (limitError) {
      toast.error(limitError);

      return null;
    }

    const uploads = accepted.map((file) => {
      const id = crypto.randomUUID();
      this.files.set(id, file);

      const asset: ComposerAsset = {
        id,
        uploadId: null,
        filename: file.name || "attachment",
        contentType: uploadContentType(file),
        size: file.size,
        intent,
        contentId:
          intent === "inline" ? `inline-${id}@openworkspace.local` : null,
        // Files larger than the transport ceiling can only become links. Do
        // not ask the browser to decode a potentially 500 MB image meanwhile.
        previewUrl:
          intent === "inline" && file.size <= EMAIL_SERVICE_MAX_BYTES
            ? URL.createObjectURL(file)
            : null,
        status: "uploading",
        error: null,
      };

      return { asset, file };
    });

    const pending = uploads.map(({ asset }) => asset);

    this.publish({
      ...this.snapshot,
      assets: [...this.snapshot.assets, ...pending],
    });

    for (const { asset, file } of uploads) {
      void this.startUpload(asset.id, file);
    }

    return pending;
  }

  retry = async (assetId: string) => {
    if (this.snapshot.phase !== "editing") {
      toast.error("Wait for the message to finish sending");

      return null;
    }

    const asset = this.getAsset(assetId);
    const file = this.files.get(assetId);

    if (!asset || !file || this.operations.has(assetId)) return null;
    const operationId = crypto.randomUUID();
    this.operations.set(assetId, operationId);
    this.requests.get(assetId)?.abort();
    this.requests.delete(assetId);
    this.replaceAsset(assetId, {
      ...asset,
      uploadId: null,
      status: "uploading",
      error: null,
    });

    if (asset.uploadId) await this.safeDiscard(asset.uploadId);

    if (!this.isCurrent(assetId, operationId)) return null;
    this.operations.delete(assetId);

    return this.startUpload(assetId, file);
  };

  remove = (assetId: string) => {
    if (this.snapshot.phase !== "editing") {
      toast.error("Wait for the message to finish sending");

      return;
    }

    const asset = this.getAsset(assetId);

    if (!asset) return;
    this.operations.delete(assetId);
    this.requests.get(assetId)?.abort();
    this.requests.delete(assetId);
    this.files.delete(assetId);
    this.progress.delete(assetId);

    if (asset.previewUrl) URL.revokeObjectURL(asset.previewUrl);

    if (asset.uploadId) void this.safeDiscard(asset.uploadId);
    const linkedAssetIds = new Set(this.snapshot.linkedAssetIds);
    linkedAssetIds.delete(assetId);
    this.publish({
      ...this.snapshot,
      assets: this.snapshot.assets.filter(
        (candidate) => candidate.id !== assetId
      ),
      linkedAssetIds,
    });
  };

  beginPlan(planKey: string) {
    if (
      this.snapshot.phase === "submitting" ||
      this.snapshot.phase === "closed"
    ) {
      return false;
    }

    this.planKey = planKey;

    return true;
  }

  resolvePlan(planKey: string, linkedAssetIds: Iterable<string>) {
    if (this.planKey !== planKey) return false;
    const nextLinkedAssetIds = new Set(linkedAssetIds);

    const linkedAssetsChanged = !setsEqual(
      this.snapshot.linkedAssetIds,
      nextLinkedAssetIds
    );

    if (!this.snapshot.planError && !linkedAssetsChanged) return true;
    this.publish({
      ...this.snapshot,
      planError: false,
      linkedAssetIds: linkedAssetsChanged
        ? nextLinkedAssetIds
        : this.snapshot.linkedAssetIds,
    });

    return true;
  }

  failPlan(planKey: string) {
    if (this.planKey !== planKey || this.snapshot.planError) return;
    this.publish({ ...this.snapshot, planError: true });
  }

  beginPreflight() {
    if (this.snapshot.phase !== "editing") return false;
    this.publish({ ...this.snapshot, phase: "preflighting" });

    return true;
  }

  cancelPreflight() {
    if (this.snapshot.phase !== "preflighting" || this.disposed) return;
    this.publish({ ...this.snapshot, phase: "editing" });
  }

  beginSubmission(assetIds: Iterable<string>, submissionKey: string) {
    if (this.snapshot.phase !== "preflighting") return null;
    this.claimedAssetIds = new Set(assetIds);

    if (this.submissionAttempt?.key !== submissionKey) {
      this.submissionAttempt = {
        id: crypto.randomUUID(),
        key: submissionKey,
      };
    }

    this.publish({ ...this.snapshot, phase: "submitting" });

    return this.submissionAttempt.id;
  }

  releaseSubmission(preserveAttempt = false) {
    const claimed = this.claimedAssetIds;
    this.claimedAssetIds = EMPTY_LINKED_ASSETS;

    if (!preserveAttempt) this.submissionAttempt = null;

    if (this.disposed) {
      for (const asset of this.snapshot.assets) {
        if (claimed.has(asset.id) && asset.uploadId) {
          void this.safeDiscard(asset.uploadId);
        }
      }

      return;
    }

    this.publish({ ...this.snapshot, phase: "editing" });
  }

  completeSubmission() {
    const claimed = this.claimedAssetIds;
    this.claimedAssetIds = EMPTY_LINKED_ASSETS;
    this.submissionAttempt = null;
    // Accepted uploads are now Worker-owned. Only retained undo assets that
    // were not part of the frozen submission snapshot are client-cleaned.
    this.disposeAssets((asset) => !claimed.has(asset.id));
    this.publish({ ...this.snapshot, assets: [], phase: "closed" });
    this.disposed = true;
  }

  close = () => {
    if (this.disposed) return;
    this.disposed = true;
    const claimed = this.claimedAssetIds;
    this.disposeAssets(
      (asset) => !claimed.has(asset.id) && !this.retainUploads
    );
    this.publish({ ...this.snapshot, phase: "closed" });
  };

  private startUpload = async (
    assetId: string,
    file: File
  ): Promise<ComposerAsset | null> => {
    const operationId = crypto.randomUUID();
    this.operations.set(assetId, operationId);
    let uploadId: string | null = null;

    try {
      const asset = this.getAsset(assetId);

      if (!asset) return null;

      const intent = await createComposerUploadIntent(this.mailboxId, {
        filename: asset.filename,
        contentType: asset.contentType,
        size: asset.size,
      });

      uploadId = intent.upload.id;

      if (!this.isCurrent(assetId, operationId)) {
        await this.safeDiscard(uploadId);

        return null;
      }

      this.replaceAsset(assetId, { ...asset, uploadId });
      await uploadComposerFile(
        intent.upload.uploadUrl,
        intent.upload.headers,
        file,
        (progress) => {
          if (this.isCurrent(assetId, operationId)) {
            this.progress.set(assetId, progress);
          }
        },
        (request) => {
          if (this.isCurrent(assetId, operationId)) {
            this.requests.set(assetId, request);
          } else {
            request.abort();
          }
        }
      );
      await completeComposerUpload(this.mailboxId, uploadId);
      this.requests.delete(assetId);

      if (!this.isCurrent(assetId, operationId)) {
        // A DELETE issued during close can finish before /complete seals its
        // immutable object. This second idempotent DELETE closes that race.
        await this.safeDiscard(uploadId);

        return null;
      }

      const current = this.getAsset(assetId);

      if (!current) {
        await this.safeDiscard(uploadId);

        return null;
      }

      const completed: ComposerAsset = {
        ...current,
        uploadId,
        status: "uploaded",
        error: null,
      };

      this.replaceAsset(assetId, completed);

      return completed;
    } catch (error) {
      this.requests.delete(assetId);

      if (!this.isCurrent(assetId, operationId)) {
        if (uploadId) await this.safeDiscard(uploadId);

        return null;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        return null;
      }

      const current = this.getAsset(assetId);

      if (!current) return null;
      this.replaceAsset(assetId, {
        ...current,
        uploadId,
        status: "error",
        error:
          error instanceof Error ? error.message : "Attachment upload failed",
      });

      return null;
    } finally {
      if (this.operations.get(assetId) === operationId) {
        this.operations.delete(assetId);
      }
    }
  };

  private isCurrent(assetId: string, operationId: string) {
    return (
      !this.disposed &&
      this.operations.get(assetId) === operationId &&
      Boolean(this.getAsset(assetId))
    );
  }

  private replaceAsset(assetId: string, next: ComposerAsset) {
    if (!this.getAsset(assetId)) return;
    this.publish({
      ...this.snapshot,
      assets: this.snapshot.assets.map((asset) =>
        asset.id === assetId ? next : asset
      ),
    });
  }

  private disposeAssets(shouldDiscard: (asset: ComposerAsset) => boolean) {
    this.operations.clear();

    for (const request of this.requests.values()) request.abort();
    this.requests.clear();

    for (const asset of this.snapshot.assets) {
      this.files.delete(asset.id);
      this.progress.delete(asset.id);

      if (asset.previewUrl) URL.revokeObjectURL(asset.previewUrl);

      if (shouldDiscard(asset) && asset.uploadId) {
        void this.safeDiscard(asset.uploadId);
      }
    }
  }

  private async safeDiscard(uploadId: string) {
    try {
      await discardComposerUpload(this.mailboxId, uploadId);
    } catch {
      // R2 lifecycle expiration is the final safety net for failed cleanup.
    }
  }

  private publish(next: ComposerSessionSnapshot) {
    this.snapshot = next;

    for (const listener of this.listeners) listener();
  }
}

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>) {
  if (left.size !== right.size) return false;

  for (const value of left) {
    if (!right.has(value)) return false;
  }

  return true;
}

export function useComposerSession(
  mailboxId: string,
  reservedAssets?: readonly { size: number }[],
  restoredAssets?: readonly ComposerAsset[]
) {
  // One session for the composer's lifetime: created once, never replaced.
  // oxlint-disable-next-line react/hook-use-state -- the lazy initializer keeps one instance; there is nothing to set
  const [session] = useState(
    () => new ComposerSession(mailboxId, reservedAssets, restoredAssets)
  );

  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot
  );

  useEffect(() => session.attach(), [session]);

  return { session, snapshot };
}
