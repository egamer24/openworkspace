import type {
  InfiniteData,
  Query,
  QueryClient,
  QueryKey,
} from "@tanstack/react-query";
import { z } from "zod";

import type { Mailbox, MailFolder } from "./types";

/**
 * Mail data in React Query carries the mailbox change counter it reflects
 * (`version`, per page for paged lists). The realtime socket announces the
 * mailbox's current counter when it opens and after every change, and only
 * data older than that is refetched.
 */

type Versioned = { version: number };

type MailboxesData = { mailboxes: (Mailbox & Versioned)[] };

type FoldersData = Versioned & { folders: MailFolder[] };

type Paged<T> = InfiniteData<T & Versioned, unknown>;

/** The query groups that hold one mailbox's data, by the first key part. */
const MAILBOX_GROUPS = ["folders", "conversations", "conversation"] as const;

/** A key of one mailbox's query: its group, then the mailbox id. */
const mailboxQueryKey = z
  .tuple([z.enum(MAILBOX_GROUPS), z.string()])
  .rest(z.unknown());

// The versions mail queries' data carries (see `Versioned` above).
const mailboxesVersions = z.object({
  mailboxes: z.array(
    z.object({ id: z.string(), version: z.number().optional() })
  ),
});

const folderVersion = z.object({ version: z.number() });

const pagesVersions = z.object({
  pages: z.array(z.object({ version: z.number() })),
});

type MailRefreshState = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  /** Mailboxes whose data is refreshed regardless of versions. */
  forced: Set<string>;
  /** Mailboxes to compare with their announced version. */
  checked: Set<string>;
  /** The highest version the server announced per mailbox. */
  announced: Map<string, number>;
  /** Queries already refetched for an announced version, so a refetch that comes back older does not loop. */
  refetchedFor: Map<string, number>;
};

const refreshStates = new WeakMap<QueryClient, MailRefreshState>();

function refreshState(client: QueryClient) {
  let state = refreshStates.get(client);

  if (!state) {
    state = {
      timer: null,
      running: false,
      forced: new Set(),
      checked: new Set(),
      announced: new Map(),
      refetchedFor: new Map(),
    };
    refreshStates.set(client, state);
  }

  return state;
}

/** The oldest version a query's data reflects for `mailboxId`; undefined without data. */
function queryVersion(query: Query, mailboxId: string): number | undefined {
  const [group] = query.queryKey;
  const { data } = query.state;

  if (!data) return undefined;

  if (group === "mailboxes") {
    const parsed = mailboxesVersions.safeParse(data);

    return parsed.success
      ? parsed.data.mailboxes.find((mailbox) => mailbox.id === mailboxId)
          ?.version
      : undefined;
  }

  if (group === "folders") {
    const parsed = folderVersion.safeParse(data);

    return parsed.success ? parsed.data.version : undefined;
  }

  const parsed = pagesVersions.safeParse(data);

  if (!parsed.success || !parsed.data.pages.length) return undefined;

  return Math.min(...parsed.data.pages.map((page) => page.version));
}

function mailboxQueries(client: QueryClient, mailboxId: string) {
  return [
    ...client.getQueryCache().findAll({ queryKey: ["mailboxes"] }),
    ...MAILBOX_GROUPS.flatMap((group) =>
      client.getQueryCache().findAll({ queryKey: [group, mailboxId] })
    ),
  ];
}

async function refreshMailboxQueries(
  client: QueryClient,
  state: MailRefreshState,
  forced: string[],
  checked: string[]
) {
  const work: Promise<unknown>[] = [];

  if (forced.length) {
    work.push(client.invalidateQueries({ queryKey: ["mailboxes"] }));
  }

  for (const mailboxId of forced) {
    for (const group of MAILBOX_GROUPS) {
      work.push(client.invalidateQueries({ queryKey: [group, mailboxId] }));
    }
  }

  const stale = new Map<string, QueryKey>();

  for (const mailboxId of checked) {
    const announced = state.announced.get(mailboxId);

    if (announced === undefined) continue;

    for (const query of mailboxQueries(client, mailboxId)) {
      const version = queryVersion(query, mailboxId);

      if (version === undefined || version >= announced) continue;

      if ((state.refetchedFor.get(query.queryHash) ?? -1) >= announced) {
        continue;
      }

      state.refetchedFor.set(query.queryHash, announced);
      stale.set(query.queryHash, query.queryKey);
    }
  }

  for (const queryKey of stale.values()) {
    work.push(client.invalidateQueries({ queryKey, exact: true }));
  }

  const results = await Promise.allSettled(work);

  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );

  if (failures.length) {
    throw new AggregateError(failures, "Could not refresh mail data");
  }
}

function schedule(client: QueryClient, state: MailRefreshState) {
  if (state.timer || state.running) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.running = true;
    const forced = [...state.forced];

    const checked = [...state.checked].filter(
      (mailboxId) => !state.forced.has(mailboxId)
    );

    state.forced.clear();
    state.checked.clear();

    void refreshMailboxQueries(client, state, forced, checked)
      .catch((error) => {
        console.error("Could not refresh mail data", error);
      })
      .finally(() => {
        state.running = false;

        // Events received during the request are drained only after it ends,
        // so an older response can never overwrite a newer refresh.
        if (state.forced.size || state.checked.size) schedule(client, state);
      });
  }, 100);
}

/** Refetches all of a mailbox's mail data shortly, e.g. after an action changed it. */
export function scheduleMailboxRefresh(client: QueryClient, mailboxId: string) {
  const state = refreshState(client);
  state.forced.add(mailboxId);
  schedule(client, state);
}

/** The server announced `version` for a mailbox: refetch what is older. */
export function noteMailboxVersion(
  client: QueryClient,
  mailboxId: string,
  version: number
) {
  const state = refreshState(client);
  state.announced.set(
    mailboxId,
    Math.max(state.announced.get(mailboxId) ?? -1, version)
  );
  state.checked.add(mailboxId);
  schedule(client, state);
}

/**
 * Checks data that arrives after an announcement, e.g. a request that was in
 * flight when the socket opened and read the mailbox before a change.
 */
export function watchMailboxVersions(client: QueryClient) {
  return client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    const [group] = event.query.queryKey;
    const state = refreshStates.get(client);

    if (!state?.announced.size) return;
    const mailboxKey = mailboxQueryKey.safeParse(event.query.queryKey);

    const mailboxIds =
      group === "mailboxes"
        ? [...state.announced.keys()]
        : mailboxKey.success
          ? [mailboxKey.data[1]]
          : [];

    let pending = false;

    for (const id of mailboxIds) {
      const announced = state.announced.get(id);
      const version = queryVersion(event.query, id);

      if (
        announced !== undefined &&
        version !== undefined &&
        version < announced
      ) {
        state.checked.add(id);
        pending = true;
      }
    }

    if (pending) schedule(client, state);
  });
}

type ConversationPage = Versioned & {
  mailboxState: string;
  folderId: string | null;
  hasIncoming: boolean;
  hasOutgoing: boolean;
  unreadCount: number;
  messages: {
    id: string;
    direction: string;
    isRead: boolean;
    viewedBy: { userId: string; name: string; readAt: string }[];
  }[];
};

type ConversationListPage = Versioned & {
  conversations: {
    conversationId: string;
    unreadCount: number;
    isUnread: boolean;
  }[];
};

function folderContains(folder: MailFolder, conversation: ConversationPage) {
  const inInbox =
    conversation.hasIncoming && conversation.mailboxState === "active";

  if (folder.kind === "custom") {
    return inInbox && conversation.folderId === folder.id;
  }

  switch (folder.systemType) {
    case "inbox": {
      return inInbox;
    }

    case "sent": {
      return conversation.hasOutgoing && conversation.mailboxState !== "trash";
    }

    case "archive":
    case "spam":
    case "trash": {
      return conversation.mailboxState === folder.systemType;
    }

    default: {
      return false;
    }
  }
}

/**
 * Applies this person's own read change to the cache instead of refetching:
 * every query that reflected the version just before the change (`version`
 * − 1) gets the change and moves to `version`, so the realtime echo of it
 * refetches nothing. Data at any other version is left to the version check.
 * Returns false when the message's previous state is not known that exactly;
 * the caller then refreshes the mailbox.
 */
export function applyOwnReadChange(
  client: QueryClient,
  input: {
    mailboxId: string;
    conversationId: string;
    messageId: string;
    isRead: boolean;
    version: number;
    reader: { userId: string; name: string };
  }
) {
  const before = input.version - 1;

  const conversationKey = [
    "conversation",
    input.mailboxId,
    input.conversationId,
  ];

  const conversation =
    client.getQueryData<Paged<ConversationPage>>(conversationKey);

  const head = conversation?.pages[0];

  const holding = conversation?.pages.find((page) =>
    page.messages.some((message) => message.id === input.messageId)
  );

  const message = holding?.messages.find((item) => item.id === input.messageId);

  if (
    !head ||
    !holding ||
    !message ||
    head.version !== before ||
    holding.version !== before
  ) {
    return false;
  }

  const delta =
    message.direction === "incoming" && message.isRead !== input.isRead
      ? input.isRead
        ? -1
        : 1
      : 0;

  const bump = <T extends Versioned>(page: T): T =>
    page.version === before ? { ...page, version: input.version } : page;

  for (const query of client
    .getQueryCache()
    .findAll({ queryKey: ["conversation", input.mailboxId] })) {
    client.setQueryData<Paged<ConversationPage>>(
      query.queryKey,
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page, index) => {
            if (page.version !== before) return page;

            if (query.queryKey[2] !== input.conversationId) return bump(page);

            return {
              ...page,
              version: input.version,
              unreadCount:
                index === 0
                  ? Math.max(0, page.unreadCount + delta)
                  : page.unreadCount,
              messages: page.messages.map((item) =>
                item.id === input.messageId
                  ? {
                      ...item,
                      isRead: input.isRead,
                      viewedBy: input.isRead
                        ? item.viewedBy.some(
                            (viewer) => viewer.userId === input.reader.userId
                          )
                          ? item.viewedBy
                          : [
                              ...item.viewedBy,
                              {
                                ...input.reader,
                                readAt: new Date().toISOString(),
                              },
                            ]
                        : item.viewedBy.filter(
                            (viewer) => viewer.userId !== input.reader.userId
                          ),
                    }
                  : item
              ),
            };
          }),
        }
    );
  }

  for (const query of client
    .getQueryCache()
    .findAll({ queryKey: ["conversations", input.mailboxId] })) {
    client.setQueryData<Paged<ConversationListPage>>(
      query.queryKey,
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) =>
            page.version === before
              ? {
                  ...page,
                  version: input.version,
                  conversations: page.conversations.map((item) => {
                    if (item.conversationId !== input.conversationId) {
                      return item;
                    }

                    const unreadCount = Math.max(0, item.unreadCount + delta);

                    return { ...item, unreadCount, isUnread: unreadCount > 0 };
                  }),
                }
              : page
          ),
        }
    );
  }

  client.setQueryData<FoldersData>(["folders", input.mailboxId], (data) =>
    data && data.version === before
      ? {
          ...data,
          version: input.version,
          folders: data.folders.map((folder) =>
            folderContains(folder, head)
              ? {
                  ...folder,
                  unreadCount: Math.max(0, folder.unreadCount + delta),
                }
              : folder
          ),
        }
      : data
  );
  const inInbox = head.hasIncoming && head.mailboxState === "active";
  client.setQueryData<MailboxesData>(
    ["mailboxes"],
    (data) =>
      data && {
        ...data,
        mailboxes: data.mailboxes.map((mailbox) =>
          mailbox.id !== input.mailboxId || mailbox.version !== before
            ? mailbox
            : {
                ...mailbox,
                version: input.version,
                unreadCount: inInbox
                  ? Math.max(0, mailbox.unreadCount + delta)
                  : mailbox.unreadCount,
              }
        ),
      }
  );

  return true;
}
