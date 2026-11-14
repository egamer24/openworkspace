import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

/** What a module's address section tells the editor it is in. */
export type AddressSection = {
  /** Whether it has changes to save; enables the editor's save button. */
  dirty: boolean;
  /** Saves its changes through the module's own routes; throws to keep the editor open. */
  save: () => Promise<void>;
};

type Registry = {
  register: (id: string, save: () => Promise<void>) => () => void;
  setDirty: (id: string, dirty: boolean) => void;
};

const AddressSectionsContext = createContext<Registry | null>(null);

/**
 * Lets a module's section in an address editor (`ClientModule.teamAddress`)
 * save with the editor's own save button instead of a button of its own:
 * the editor saves the address, then each section with `dirty` set, and
 * closes only if all of them succeed. A section that hides, say for the
 * delivery chosen now, unmounts the component calling this, so it no longer
 * takes part.
 */
export function useAddressSection({ dirty, save }: AddressSection) {
  const registry = useContext(AddressSectionsContext);
  const id = useId();
  const latestSave = useRef(save);

  useLayoutEffect(() => {
    latestSave.current = save;
  });

  useEffect(
    () => registry?.register(id, () => latestSave.current()),
    [registry, id]
  );

  useEffect(() => {
    registry?.setDirty(id, dirty);
  }, [registry, id, dirty]);
}

/**
 * The sections of one address editor: whether any has changes, and a save
 * that runs the changed ones. Render them in an `AddressSectionsProvider`.
 */
export function useAddressSections() {
  const saves = useRef(new Map<string, () => Promise<void>>());
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(new Set());

  const registry = useMemo<Registry>(() => {
    const setDirty = (id: string, dirty: boolean) =>
      setDirtyIds((current) => {
        if (current.has(id) === dirty) return current;
        const next = new Set(current);

        if (dirty) next.add(id);
        else next.delete(id);

        return next;
      });

    return {
      register: (id, sectionSave) => {
        saves.current.set(id, sectionSave);

        return () => {
          saves.current.delete(id);
          setDirty(id, false);
        };
      },
      setDirty,
    };
  }, []);

  /** Saves every changed section; throws with their errors if any failed. */
  async function save() {
    const results = await Promise.allSettled(
      [...dirtyIds].map((id) => saves.current.get(id)?.())
    );

    const errors = results.flatMap((result) =>
      result.status === "rejected"
        ? [
            result.reason instanceof Error
              ? result.reason.message
              : "A section wasn't saved",
          ]
        : []
    );

    if (errors.length) throw new Error(errors.join(" "));
  }

  return { dirty: dirtyIds.size > 0, save, registry };
}

/** Where an editor renders its sections, so `useAddressSection` finds it. */
export function AddressSectionsProvider({
  sections,
  children,
}: {
  sections: ReturnType<typeof useAddressSections>;
  children: ReactNode;
}) {
  return (
    <AddressSectionsContext value={sections.registry}>
      {children}
    </AddressSectionsContext>
  );
}
