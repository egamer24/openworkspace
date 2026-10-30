import {
  getFiletypeFromFileName,
  getSharedHighlighter,
  type FileDiffContentsLoader,
  type SelectedLineRange,
} from "@pierre/diffs";
import { File, PatchDiff } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import type { CodeFileChange } from "../../shared/code";
import { cn } from "@/lib/utils";

/**
 * Code and diff rendering with Pierre's `@pierre/diffs`. Components mount only
 * after the shared Shiki highlighter has the needed grammars and both themes,
 * so code never flashes unhighlighted before colors arrive.
 */

export const CODE_THEMES = { light: "pierre-light", dark: "pierre-dark" } as const;

function subscribeTheme(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/** Follows the app theme, which toggles the `dark` class on `<html>`. */
export function useDarkMode() {
  return useSyncExternalStore(
    subscribeTheme,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
}

export function useHighlighterReady(paths: string[]) {
  const languages = [...new Set(paths.map((path) => getFiletypeFromFileName(path)))].sort();
  return useQuery({
    queryKey: ["diffs-highlighter", languages.join(",")],
    queryFn: async () => {
      await getSharedHighlighter({
        themes: [CODE_THEMES.light, CODE_THEMES.dark],
        langs: languages,
      });
      return true;
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    // A failed grammar load still renders plain text rather than nothing.
    retry: false,
  });
}

/** Placeholder with the code's shape while grammars load. */
export function CodeSkeleton({ lines }: { lines: number }) {
  const rows = Math.max(1, Math.min(lines, 24));
  return (
    <div className="space-y-2 px-4 py-3" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="h-3 animate-pulse rounded bg-muted"
          style={{ width: `${30 + ((index * 37) % 60)}%` }}
        />
      ))}
    </div>
  );
}

export function CodeFile({
  path,
  contents,
  cacheKey,
  selectedLines,
  onSelectLines,
  className,
}: {
  path: string;
  contents: string;
  cacheKey: string;
  selectedLines: SelectedLineRange | null;
  onSelectLines: (range: SelectedLineRange | null) => void;
  className?: string;
}) {
  const dark = useDarkMode();
  const ready = useHighlighterReady([path]);
  // A final newline is a line terminator, not an empty last line.
  const file = useMemo(
    () => ({ name: path, contents: contents.replace(/\r?\n$/u, ""), cacheKey }),
    [path, contents, cacheKey],
  );
  if (ready.isPending) return <CodeSkeleton lines={contents.split("\n").length} />;
  return (
    <File
      file={file}
      selectedLines={selectedLines}
      className={cn("block", className)}
      options={{
        theme: CODE_THEMES,
        themeType: dark ? "dark" : "light",
        disableFileHeader: true,
        overflow: "scroll",
        enableLineSelection: true,
        lineHoverHighlight: "number",
        onLineSelected: onSelectLines,
      }}
    />
  );
}

/** Builds a git-style patch for one file from the server's hunks. */
export function filePatch(file: CodeFileChange) {
  const before = file.status === "added" ? "/dev/null" : `a/${file.path}`;
  const after = file.status === "deleted" ? "/dev/null" : `b/${file.path}`;
  const mode = file.status === "added"
    ? "new file mode 100644\n"
    : file.status === "deleted" ? "deleted file mode 100644\n" : "";
  return `diff --git a/${file.path} b/${file.path}\n${mode}--- ${before}\n+++ ${after}\n${file.patch}\n`;
}

export function PatchFile({
  file,
  split,
  loadFiles,
}: {
  file: CodeFileChange;
  split: boolean;
  loadFiles?: FileDiffContentsLoader;
}) {
  const dark = useDarkMode();
  const ready = useHighlighterReady([file.path]);
  const patch = useMemo(() => filePatch(file), [file]);
  if (ready.isPending) return <CodeSkeleton lines={file.additions + file.deletions} />;
  return (
    <PatchDiff
      patch={patch}
      className="block"
      options={{
        theme: CODE_THEMES,
        themeType: dark ? "dark" : "light",
        diffStyle: split ? "split" : "unified",
        disableFileHeader: true,
        overflow: "scroll",
        lineDiffType: "word",
        ...(loadFiles ? { loadDiffFiles: loadFiles } : {}),
      }}
    />
  );
}
