import { useCallback, useSyncExternalStore } from "react";
import { z } from "zod";

export const themeSchema = z.enum(["light", "dark", "system"]);

export type Theme = z.infer<typeof themeSchema>;

const STORAGE_KEY = "openworkspace-theme";
const listeners = new Set<() => void>();

function readTheme(): Theme {
  const stored = themeSchema.safeParse(localStorage.getItem(STORAGE_KEY));

  return stored.success ? stored.data : "system";
}

function applyTheme(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);

  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  // The browser's toolbar follows the canvas (--background); index.html sets it on load.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#080808" : "#edeff4");
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const media = matchMedia("(prefers-color-scheme: dark)");

  const onMedia = () => {
    if (readTheme() === "system") applyTheme("system");
    listener();
  };

  media.addEventListener("change", onMedia);

  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", onMedia);
  };
}

function snapshot() {
  return readTheme();
}

function serverSnapshot(): Theme {
  return "system";
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, snapshot, serverSnapshot);

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
    listeners.forEach((listener) => listener());
  }, []);

  return { theme, setTheme };
}
