import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, responseJson, type SuccessfulResponse } from "@/lib/api";
import type { ComposerAsset, ComposerSession } from "./composer-session";

type DraftRoute = (typeof api.api.mail.drafts)[":id"];

export type DraftSaveBody = Omit<
  Parameters<DraftRoute["$put"]>[0]["json"],
  "expectedVersion"
>;

export type SavedDraft = SuccessfulResponse<
  Awaited<ReturnType<DraftRoute["$get"]>>
>["draft"];

export type DraftSummary = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.mail.drafts.$get>>
>["drafts"][number];

const AUTOSAVE_DELAY_MS = 2_000;

export function newDraftId() {
  return `dft_${crypto.randomUUID()}`;
}

export function useDrafts(mailboxId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["drafts", mailboxId],
    enabled: Boolean(mailboxId) && enabled,
    queryFn: async ({ signal }) => (await responseJson(await api.api.mail.drafts.$get(
      { query: { mailboxId: mailboxId! } },
      { init: { signal } },
    ))).drafts,
  });
}

export async function fetchDraft(mailboxId: string, draftId: string) {
  return (await responseJson(await api.api.mail.drafts[":id"].$get({
    param: { id: draftId },
    query: { mailboxId },
  }))).draft;
}

/** Composer assets for a reopened draft; uploads were restored by the server. */
export function draftAssets(mailboxId: string, draft: SavedDraft): ComposerAsset[] {
  return draft.attachmentsJson.map((file) => ({
    id: file.assetId,
    uploadId: file.uploadId,
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    intent: file.intent,
    contentId: file.contentId,
    previewUrl: file.intent === "inline"
      ? `/api/mail/drafts/${encodeURIComponent(draft.id)}/attachments/${encodeURIComponent(file.uploadId)}?mailboxId=${encodeURIComponent(mailboxId)}`
      : null,
    status: "uploaded",
    error: null,
  }));
}

/** Uploaded assets in the shape the draft API stores. */
export function draftAttachments(assets: readonly ComposerAsset[]) {
  return assets.flatMap((asset) =>
    asset.status === "uploaded" && asset.uploadId
      ? [{
          assetId: asset.id,
          uploadId: asset.uploadId,
          intent: asset.intent,
          contentId: asset.contentId,
        }]
      : []
  );
}

/**
 * Saves the composer a couple of seconds after it stops changing. Writes carry
 * the version they were based on, so a second window editing the same draft
 * gets a conflict instead of silently overwriting it.
 */
export function useDraftAutosave(input: {
  mailboxId: string;
  restored?: { id: string; version: number };
  /** Changes whenever anything worth saving changes. */
  changeKey: string;
  enabled: boolean;
  buildPayload: () => DraftSaveBody;
  session: ComposerSession;
}) {
  const client = useQueryClient();
  const [draftId, setDraftId] = useState(() => input.restored?.id ?? newDraftId());
  const version = useRef(input.restored?.version ?? 0);
  const initialKey = useRef<string | null>(input.changeKey);
  const savedKey = useRef<string | null>(input.changeKey);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const conflicted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ ...input, draftId });
  latest.current = { ...input, draftId };
  // The editor is gone by the time an unmount cleanup runs, so the last
  // payload is cached whenever the content changes.
  const lastPayload = useRef<DraftSaveBody | null>(null);

  const refresh = useCallback((mailboxId: string) => {
    void client.invalidateQueries({ queryKey: ["drafts", mailboxId] });
    void client.invalidateQueries({ queryKey: ["folders", mailboxId] });
  }, [client]);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const save = useCallback((fromCache = false) => {
    queue.current = queue.current.then(async () => {
      const { changeKey, buildPayload, mailboxId, draftId: id } = latest.current;
      if (conflicted.current || changeKey === savedKey.current) return;
      const payload = fromCache ? lastPayload.current : buildPayload();
      if (!payload) return;
      try {
        const response = await api.api.mail.drafts[":id"].$put({
          param: { id },
          query: { mailboxId },
          json: { ...payload, expectedVersion: version.current },
        });
        if (response.status === 409) {
          conflicted.current = true;
          toast.error("This draft was changed in another window, so it is no longer saved here.");
          return;
        }
        const result = await responseJson(response);
        version.current = result.version;
        savedKey.current = changeKey;
        refresh(mailboxId);
      } catch (error) {
        console.error("Could not save draft", error);
        toast.error("Draft could not be saved");
      }
    });
    return queue.current;
  }, [refresh]);

  useEffect(() => {
    if (initialKey.current === null) {
      // After reset(): the first state seen is the new empty baseline.
      initialKey.current = input.changeKey;
      savedKey.current = input.changeKey;
      return;
    }
    if (!input.enabled || conflicted.current) return;
    if (input.changeKey === savedKey.current) return;
    if (version.current === 0 && input.changeKey === initialKey.current) return;
    lastPayload.current = latest.current.buildPayload();
    timer.current = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    return clearTimer;
  }, [input.changeKey, input.enabled, save]);

  useEffect(() => () => {
    // Unmounted without an explicit close (mailbox switch, reply collapsed):
    // keep the uploads and save whatever is still pending.
    const unsaved = !conflicted.current
      && latest.current.changeKey !== savedKey.current
      && !(version.current === 0 && latest.current.changeKey === initialKey.current);
    if (unsaved || (version.current > 0 && !conflicted.current)) {
      latest.current.session.retainAll();
    }
    if (unsaved) void save(true);
  }, [save]);

  /** Saves pending changes now. Resolves true when a draft exists on the server. */
  const flush = useCallback(async () => {
    clearTimer();
    const { changeKey } = latest.current;
    if (!(version.current === 0 && changeKey === initialKey.current)) await save();
    return version.current > 0 && !conflicted.current;
  }, [save]);

  const discard = useCallback(async () => {
    clearTimer();
    conflicted.current = true;
    await queue.current;
    if (version.current === 0) return;
    const { mailboxId, draftId: id } = latest.current;
    await responseJson(await api.api.mail.drafts[":id"].$delete({
      param: { id },
      query: { mailboxId },
    }));
    refresh(mailboxId);
  }, [refresh]);

  /** Starts a fresh draft, e.g. after a reply was sent from this composer. */
  const reset = useCallback(() => {
    clearTimer();
    setDraftId(newDraftId());
    version.current = 0;
    conflicted.current = false;
    initialKey.current = null;
    refresh(latest.current.mailboxId);
  }, [refresh]);

  return { draftId, flush, discard, reset };
}
