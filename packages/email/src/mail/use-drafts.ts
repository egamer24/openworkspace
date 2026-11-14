import { ApiError, responseJson } from "@open-workspace/core/ui";
import type { SuccessfulResponse } from "@open-workspace/core/ui";
import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { toast } from "sonner";

import { DRAFTS_FOLDER_ID } from "../../shared/folder-order";
import { mailApi } from "../lib/mail-api";
import type { ComposerSession } from "./composer-session";
import { scheduleMailboxRefresh } from "./mail-query-cache";

export type SavedDraft = SuccessfulResponse<
  Awaited<ReturnType<typeof mailApi.api.mail.drafts.$get>>
>["drafts"][number];

/** What a composer saves: everything but the draft's identity and version. */
export type DraftContent = Omit<
  Parameters<(typeof mailApi.api.mail.drafts)[":id"]["$put"]>[0]["json"],
  "expectedVersion"
>;

const AUTOSAVE_DELAY_MS = 2000;

/**
 * Browsers refuse a keepalive request whose body is over 64 KiB; a larger
 * draft is sent as an ordinary request, which a closing page may cut off.
 */
const KEEPALIVE_MAX_BYTES = 60_000;

/** A new draft's id, chosen by the composer so its first save can be retried. */
export function newDraftId() {
  return `drf_${crypto.randomUUID()}`;
}

function draftsKey(mailboxId: string | undefined) {
  return ["drafts", mailboxId] as const;
}

/** The person's drafts in a mailbox they can send from; undefined loads nothing. */
export function useDrafts(mailboxId: string | undefined) {
  return useQuery({
    queryKey: draftsKey(mailboxId),
    queryFn: mailboxId
      ? async ({ signal }) =>
          (
            await responseJson(
              await mailApi.api.mail.drafts.$get(
                { query: { mailboxId } },
                { init: { signal } }
              )
            )
          ).drafts
      : skipToken,
  });
}

async function deleteDraft(mailboxId: string, draftId: string) {
  await responseJson(
    await mailApi.api.mail.drafts[":id"].$delete({
      param: { id: draftId },
      query: { mailboxId },
    })
  );
}

/** Drops drafts from what this client shows, then refreshes the mailbox. */
function forgetDrafts(
  client: QueryClient,
  mailboxId: string,
  draftIds: readonly string[]
) {
  client.setQueryData<SavedDraft[]>(draftsKey(mailboxId), (drafts) =>
    drafts?.filter((draft) => !draftIds.includes(draft.id))
  );
  scheduleMailboxRefresh(client, mailboxId);
}

/** Deletes drafts, e.g. those selected in Drafts. */
export function useDiscardDrafts() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async (input: { mailboxId: string; draftIds: string[] }) => {
      await Promise.all(
        input.draftIds.map((id) => deleteDraft(input.mailboxId, id))
      );
    },
    onSettled: (_result, _error, input) =>
      forgetDrafts(client, input.mailboxId, input.draftIds),
  });
}

/** Deletes one draft, e.g. a conversation's reply draft being replaced. */
export function useDiscardDraft() {
  const client = useQueryClient();

  return async (mailboxId: string, draftId: string) => {
    await deleteDraft(mailboxId, draftId);
    forgetDrafts(client, mailboxId, [draftId]);
  };
}

/**
 * Saves a composer as a draft about two seconds after it stops changing, at
 * once when it unmounts while still editing (closing, switching mailbox,
 * leaving the conversation), and with `keepalive` when the page is hidden or
 * goes away (closing the tab, reloading, locking the screen). While a change
 * is unsaved or the last save failed, leaving the page asks first. Saves
 * carry the version they were based on, so a second window on the same draft
 * gets a conflict instead of overwriting it; after one, this composer stops
 * saving.
 */
export function useDraftAutosave({
  mailboxId,
  session,
  draftId,
  restored,
  content,
  blank,
  editing,
  onSaved,
}: {
  mailboxId: string;
  /** Kept from discarding its uploads on close while a draft holds them. */
  session: ComposerSession;
  draftId: string;
  /** The draft this composer reopened. */
  restored?: Pick<SavedDraft, "version">;
  content: DraftContent;
  /**
   * Nothing worth keeping yet (an untouched composer, or one holding only
   * the signature it opened with): it creates no draft. Read when saving.
   */
  blank: () => boolean;
  /** False while sending and once sent: only an editing composer saves. */
  editing: boolean;
  /** The draft was first saved: it now exists under `draftId`. */
  onSaved?: (draftId: string) => void;
}) {
  const client = useQueryClient();
  const key = JSON.stringify(content);

  const saved = useRef({
    key,
    version: restored?.version ?? 0,
    stopped: false,
    inFlight: 0,
    failed: false,
    queue: Promise.resolve(),
  });

  // Saves read this render's values; the timer, page events and unmount run later.
  const latest = useRef({ mailboxId, content, key, blank, editing, onSaved });
  useLayoutEffect(() => {
    latest.current = { mailboxId, content, key, blank, editing, onSaved };
    // The close-time save copies the uploads, so closing must not delete them.
    session.setRetainUploads(!blank() && !saved.current.stopped);
  });

  const save = useCallback(
    (keepalive = false, override?: DraftContent) => {
      const state = saved.current;
      const { mailboxId: target, blank: isBlank } = latest.current;
      const json = override ?? latest.current.content;
      const jsonKey = JSON.stringify(json);

      if (
        state.stopped ||
        jsonKey === state.key ||
        (!state.version && isBlank())
      ) {
        return;
      }

      async function putDraft(
        body: DraftContent & { expectedVersion: number },
        keep: boolean
      ) {
        try {
          const response = await mailApi.api.mail.drafts[":id"].$put(
            {
              param: { id: draftId },
              query: { mailboxId: target },
              json: body,
            },
            {
              init: {
                keepalive:
                  keep && JSON.stringify(body).length < KEEPALIVE_MAX_BYTES,
              },
            }
          );

          if (response.status === 409) {
            state.stopped = true;
            toast.error(
              "This draft was changed in another window, so it is no longer saved here"
            );

            return;
          }

          const { draft } = await responseJson(response);
          const created = state.version === 0;
          state.version = draft.version;
          state.failed = false;

          if (created) latest.current.onSaved?.(draftId);
          void client.invalidateQueries({ queryKey: draftsKey(target) });
          // The Drafts folder shows the text as it is now.
          void client.invalidateQueries({
            queryKey: ["conversations", target, DRAFTS_FOLDER_ID],
          });
        } catch (error) {
          // The next change, or leaving the page, tries again.
          state.key = "";
          state.failed = true;
          toast.error(
            error instanceof ApiError
              ? error.message
              : "Could not save the draft"
          );
        }
      }

      // ponytail: a first save still in flight when the message is sent can
      // land after the server deleted the draft and leave a stale one behind.
      state.key = jsonKey;
      state.inFlight += 1;
      state.queue = state.queue.then(async () => {
        if (state.stopped) {
          state.inFlight -= 1;

          return;
        }

        // Not in a `finally`: the React Compiler does not handle one.
        await putDraft({ ...json, expectedVersion: state.version }, keepalive);
        state.inFlight -= 1;
      });
    },
    [client, draftId]
  );

  useEffect(() => {
    if (!editing || key === saved.current.key) return;
    const timer = setTimeout(() => save(), AUTOSAVE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [key, editing, save]);

  // The page going away or out of sight saves what the timer had not yet.
  useEffect(() => {
    function saveNow() {
      if (latest.current.editing) save(true);
    }

    function saveIfHidden() {
      if (document.visibilityState === "hidden") saveNow();
    }

    function confirmLeaving(event: BeforeUnloadEvent) {
      const state = saved.current;

      const unsaved =
        !state.stopped &&
        latest.current.editing &&
        (state.inFlight > 0 ||
          state.failed ||
          (latest.current.key !== state.key &&
            !(state.version === 0 && latest.current.blank())));

      if (unsaved) event.preventDefault();
    }

    document.addEventListener("visibilitychange", saveIfHidden);
    window.addEventListener("pagehide", saveNow);
    window.addEventListener("beforeunload", confirmLeaving);

    return () => {
      document.removeEventListener("visibilitychange", saveIfHidden);
      window.removeEventListener("pagehide", saveNow);
      window.removeEventListener("beforeunload", confirmLeaving);
    };
  }, [save]);

  // Unmounting mid-edit saves what the timer had not yet; keepalive lets the
  // request outlive a page that is closing.
  useEffect(
    () => () => {
      if (latest.current.editing) save(true);
    },
    [save]
  );

  return {
    draftId,
    /** Saves pending changes now, e.g. when the composer closes. */
    flush: (override?: DraftContent) => save(false, override),
    /** Stops saving and deletes the draft, if one was saved. */
    discard: async () => {
      const state = saved.current;
      state.stopped = true;
      session.setRetainUploads(false);
      await state.queue;

      if (state.version === 0) return;
      await deleteDraft(mailboxId, draftId);
      forgetDrafts(client, mailboxId, [draftId]);
    },
    /** Stops saving once the message was sent (the server deleted the draft). */
    sent: () => {
      saved.current.stopped = true;
      forgetDrafts(client, latest.current.mailboxId, [draftId]);
    },
  };
}

async function conversationPage(
  mailboxId: string,
  conversationId: string,
  cursor: string | undefined
) {
  return responseJson(
    await mailApi.api.mail.conversations[":id"].$get({
      param: { id: conversationId },
      query: { mailboxId, limit: "25", cursor },
    })
  );
}

/** The message a forward draft forwards, looked up page by page in its conversation. */
export async function findDraftSource(
  mailboxId: string,
  draft: Pick<SavedDraft, "conversationId" | "sourceEmailId">
) {
  const { conversationId, sourceEmailId } = draft;

  if (!conversationId || !sourceEmailId) return undefined;
  let cursor: string | undefined;

  // ponytail: stops after 10 pages (250 messages); a deeper source reads as gone.
  for (let page = 0; page < 10; page += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each page needs the previous page's cursor
    const result = await conversationPage(mailboxId, conversationId, cursor);

    const message = result.messages.find((item) => item.id === sourceEmailId);

    if (message) return message;

    if (!result.nextCursor) return undefined;
    cursor = result.nextCursor;
  }

  return undefined;
}
