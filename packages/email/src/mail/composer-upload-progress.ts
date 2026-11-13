import { useSyncExternalStore } from "react";

export type ComposerUploadProgressStore = {
  get: (localId: string) => number;
  subscribe: (localId: string, listener: () => void) => () => void;
};

type MutableComposerUploadProgressStore = ComposerUploadProgressStore & {
  delete: (localId: string) => void;
  set: (localId: string, progress: number) => void;
};

export function createComposerUploadProgressStore(): MutableComposerUploadProgressStore {
  const values = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();

  return {
    get: (localId) => values.get(localId) ?? 0,
    subscribe: (localId, listener) => {
      const current = listeners.get(localId) ?? new Set();
      current.add(listener);
      listeners.set(localId, current);

      return () => {
        current.delete(listener);

        if (!current.size) listeners.delete(localId);
      };
    },
    set: (localId, progress) => {
      if (values.get(localId) === progress) return;
      values.set(localId, progress);

      for (const listener of listeners.get(localId) ?? []) listener();
    },
    delete: (localId) => {
      values.delete(localId);

      for (const listener of listeners.get(localId) ?? []) listener();
    },
  };
}

export function useComposerUploadProgress(
  store: ComposerUploadProgressStore,
  localId: string
) {
  return useSyncExternalStore(
    (listener) => store.subscribe(localId, listener),
    () => store.get(localId),
    () => 0
  );
}
