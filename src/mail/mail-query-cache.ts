import type { QueryClient } from "@tanstack/react-query";

type MailRefreshState = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  pendingMailboxIds: Set<string>;
};

const refreshStates = new WeakMap<QueryClient, MailRefreshState>();

async function refreshMailboxQueries(
  client: QueryClient,
  mailboxIds: string[],
) {
  const results = await Promise.allSettled([
    client.invalidateQueries({ queryKey: ["mailboxes"] }),
    ...mailboxIds.flatMap((mailboxId) => [
      client.invalidateQueries({ queryKey: ["folders", mailboxId] }),
      client.invalidateQueries({ queryKey: ["conversations", mailboxId] }),
      client.invalidateQueries({ queryKey: ["conversation", mailboxId] }),
      client.invalidateQueries({ queryKey: ["drafts", mailboxId] }),
    ]),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length) {
    throw new AggregateError(failures, "Could not refresh mail data");
  }
}

export function scheduleMailboxRefresh(
  client: QueryClient,
  mailboxId: string,
) {
  let state = refreshStates.get(client);
  if (!state) {
    state = {
      timer: null,
      running: false,
      pendingMailboxIds: new Set(),
    };
    refreshStates.set(client, state);
  }
  state.pendingMailboxIds.add(mailboxId);
  if (state.timer || state.running) return;

  const run = () => {
    state.timer = setTimeout(() => {
      state.timer = null;
      state.running = true;
      const mailboxIds = [...state.pendingMailboxIds];
      state.pendingMailboxIds.clear();

      void refreshMailboxQueries(client, mailboxIds).catch((error) => {
        console.error("Could not refresh mail data", error);
      }).finally(() => {
        state.running = false;
        // Events received during the request are drained only after it ends,
        // so an older response can never overwrite a newer refresh.
        if (state.pendingMailboxIds.size) run();
        else refreshStates.delete(client);
      });
    }, 100);
  };
  run();
}
