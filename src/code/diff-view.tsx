import type { FileDiffContentsLoader } from "@pierre/diffs";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { ChevronRight, Columns2, FileCode2, Rows3 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import type { CodeFileChange } from "../../shared/code";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { api, responseJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PatchFile } from "./pierre";

const SPLIT_KEY = "openworkspace.diff.split";

function readSplit() {
  try {
    return localStorage.getItem(SPLIT_KEY) === "1";
  } catch {
    return false;
  }
}

const statusVariant: Record<CodeFileChange["status"], "success" | "destructive" | "info"> = {
  added: "success",
  deleted: "destructive",
  modified: "info",
};

function fileAnchor(path: string) {
  return `diff-${path.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
}

/** Revisions on both sides of a diff, used to expand collapsed context. */
export type DiffSides = { repo: string; before: string | null; after: string };

function contentsLoader(sides: DiffSides): FileDiffContentsLoader {
  const read = async (ref: string, path: string) => {
    const { blob } = await responseJson(
      await api.api.code.repos[":name"].blob.$get({
        param: { name: sides.repo },
        query: { ref, path },
      }),
    );
    if (blob.text === null) throw new Error("File cannot be expanded");
    return { name: path, contents: blob.text, cacheKey: `${blob.hash}` };
  };
  return async (fileDiff) => {
    if (!sides.before) throw new Error("No base revision");
    const [oldFile, newFile] = await Promise.all([
      read(sides.before, fileDiff.prevName ?? fileDiff.name),
      read(sides.after, fileDiff.name),
    ]);
    return { oldFile, newFile };
  };
}

function FileDiffPanel({
  file,
  split,
  viewed,
  onViewed,
  fileLink,
  loadFiles,
}: {
  file: CodeFileChange;
  split: boolean;
  viewed: boolean;
  onViewed: (viewed: boolean) => void;
  fileLink?: (path: string) => string;
  loadFiles?: FileDiffContentsLoader;
}) {
  const [open, setOpen] = useState(true);
  const expanded = open && !viewed;
  return (
    <section
      id={fileAnchor(file.path)}
      className="scroll-mt-20 overflow-hidden rounded-xl border border-border bg-surface"
    >
      <div className="flex items-center gap-2 border-b border-border/70 bg-surface-sunken/60 px-3 py-2 text-sm">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <ChevronRight className={cn("size-4 shrink-0 transition-transform", expanded && "rotate-90")} />
          <span className="min-w-0 truncate font-mono text-xs font-medium">{file.path}</span>
        </button>
        <Badge variant={statusVariant[file.status]} className="hidden sm:inline-flex">{file.status}</Badge>
        <span className="font-mono text-xs text-success">+{file.additions}</span>
        <span className="font-mono text-xs text-destructive">-{file.deletions}</span>
        {fileLink && file.status !== "deleted" && (
          <Button variant="ghost" size="icon-xs" nativeButton={false} render={<Link to={fileLink(file.path)} />}>
            <FileCode2 />
            <span className="sr-only">View file</span>
          </Button>
        )}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={viewed} onCheckedChange={(value) => onViewed(Boolean(value))} />
          <span className="hidden sm:inline">Viewed</span>
        </label>
      </div>
      {expanded && (file.patch
        ? <PatchFile file={file} split={split} loadFiles={file.status === "modified" ? loadFiles : undefined} />
        : <p className="p-4 text-sm text-muted-foreground">{file.note ?? "No changes to show."}</p>)}
    </section>
  );
}

function ChangedFilesTree({ files, viewed }: { files: CodeFileChange[]; viewed: Set<string> }) {
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const { model } = useFileTree({
    paths,
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    icons: { set: "standard", colored: true },
    gitStatus: files.map((file) => ({ path: file.path, status: file.status })),
    onSelectionChange: (selected) => {
      const path = selected[0];
      if (path && !path.endsWith("/")) {
        document.getElementById(fileAnchor(path))?.scrollIntoView({ behavior: "smooth" });
      }
    },
  });
  useEffect(() => {
    model.resetPaths(paths);
    model.setGitStatus(files.map((file) => ({ path: file.path, status: file.status })));
  }, [model, paths, files]);
  const height = Math.min(files.length * 2 + 4, 40) * 28;
  return (
    <div className="sticky top-4 overflow-hidden rounded-xl border border-border bg-surface">
      <p className="border-b border-border/70 px-3 py-2 text-xs font-semibold text-muted-foreground">
        {files.length} files · {viewed.size} viewed
      </p>
      <FileTree model={model} className="repo-tree" style={{ height: `min(${height}px, calc(100dvh - 8rem))` }} />
    </div>
  );
}

/** Changed files with a file tree, unified/split toggle, and viewed markers. */
export function DiffList({
  files,
  truncated,
  fileLink,
  sides,
}: {
  files: CodeFileChange[];
  truncated: boolean;
  fileLink?: (path: string) => string;
  sides?: DiffSides;
}) {
  const [split, setSplit] = useState(readSplit);
  const [viewed, setViewed] = useState<Set<string>>(() => new Set());
  const loadFiles = useMemo(() => (sides?.before ? contentsLoader(sides) : undefined), [sides?.repo, sides?.before, sides?.after]);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  function changeSplit(next: boolean) {
    setSplit(next);
    try {
      localStorage.setItem(SPLIT_KEY, next ? "1" : "0");
    } catch {
      // Preference only.
    }
  }

  if (files.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border bg-surface p-8 text-center text-sm text-muted-foreground">
        No file changes.
      </p>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <nav className="hidden lg:block" aria-label="Changed files">
        <ChangedFilesTree files={files} viewed={viewed} />
      </nav>
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex-1 text-sm text-muted-foreground">
            {files.length} changed file{files.length === 1 ? "" : "s"} with{" "}
            <span className="text-success">{additions} additions</span> and{" "}
            <span className="text-destructive">{deletions} deletions</span>
            {truncated ? " (list truncated)" : ""}
          </p>
          <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
            <Button size="xs" variant={split ? "ghost" : "secondary"} onClick={() => changeSplit(false)} aria-pressed={!split}>
              <Rows3 /> Unified
            </Button>
            <Button size="xs" variant={split ? "secondary" : "ghost"} onClick={() => changeSplit(true)} aria-pressed={split}>
              <Columns2 /> Split
            </Button>
          </div>
        </div>
        {files.map((file) => (
          <FileDiffPanel
            key={file.path}
            file={file}
            split={split}
            viewed={viewed.has(file.path)}
            fileLink={fileLink}
            loadFiles={loadFiles}
            onViewed={(value) => setViewed((current) => {
              const next = new Set(current);
              if (value) next.add(file.path);
              else next.delete(file.path);
              return next;
            })}
          />
        ))}
      </div>
    </div>
  );
}
