import { lazy } from "react";
import type { ComponentType } from "react";

/**
 * A lazily loaded component whose code can be fetched ahead of rendering.
 * Once `preload()` settled, the component renders without suspending: no
 * Suspense fallback, and so none of React's fallback throttling (300 ms)
 * before it appears.
 */
export function preloadable<P extends object>(
  load: () => Promise<ComponentType<P>>
) {
  let loaded: ComponentType<P> | undefined;
  let loading: Promise<ComponentType<P>> | undefined;

  const preload = () => {
    loading ??= load().then(
      (component) => {
        loaded = component;

        return component;
      },
      (cause: unknown) => {
        loading = undefined;
        throw cause;
      }
    );

    return loading;
  };

  // React.lazy resolves synchronously when its thenable calls back at once.
  const Component = lazy(() => {
    if (!loaded) return preload().then((component) => ({ default: component }));
    const component = loaded;

    const resolved = {
      // oxlint-disable-next-line unicorn/no-thenable -- a lazy component's module is awaited like a promise
      then: (resolve: (value: { default: ComponentType<P> }) => void) =>
        resolve({ default: component }),
    };

    // SAFETY: React.lazy only calls `then` on what `load` returns (any
    // thenable works at runtime); @types/react asks for a full Promise.
    return resolved as Promise<{ default: ComponentType<P> }>;
  });

  return { Component, preload };
}
