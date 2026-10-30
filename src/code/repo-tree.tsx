import type { FileTreeDirectoryHandle } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router";
import { useFileIndex } from "./code-api";
import type { RepoLinks } from "./repo-shared";

function ancestors(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, index) => `${parts.slice(0, index + 1).join("/")}/`);
}

/** Whole-repository file tree beside the code view, built on `@pierre/trees`. */
export function RepoFileTree({
  repo,
  refName,
  path,
  kind,
  links,
}: {
  repo: string;
  refName: string;
  path: string;
  kind: "tree" | "blob";
  links: RepoLinks;
}) {
  const navigate = useNavigate();
  const files = useFileIndex(repo, refName, true);
  const paths = useMemo(() => files.data?.paths ?? [], [files.data]);
  // The tree reports selections it caused and ones we set; only user picks navigate.
  const current = useRef({ path, kind });
  current.current = { path, kind };
  const { model } = useFileTree({
    paths: [],
    initialExpansion: "closed",
    flattenEmptyDirectories: true,
    icons: { set: "standard", colored: true },
    search: true,
    onSelectionChange: (selected) => {
      const target = selected[0];
      if (!target) return;
      const directory = target.endsWith("/");
      const clean = target.replace(/\/$/u, "");
      if (clean === current.current.path) return;
      if (!directory) navigate(links.blob(clean));
    },
  });

  useEffect(() => {
    if (paths.length === 0) return;
    model.resetPaths(paths, { initialExpandedPaths: ancestors(kind === "tree" && path ? `${path}/x` : path) });
  }, [model, paths]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (paths.length === 0 || kind !== "blob" || !path) return;
    for (const directory of ancestors(path)) {
      const item = model.getItem(directory);
      if (item?.isDirectory()) (item as FileTreeDirectoryHandle).expand();
    }
    const item = model.getItem(path);
    if (item && !item.isSelected()) {
      item.select();
      model.scrollToPath(path, { focus: false, offset: "nearest" });
    }
  }, [model, paths, path, kind]);

  if (files.isPending) {
    return <div className="h-64 animate-pulse rounded-xl bg-surface-sunken/60" />;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <FileTree
        model={model}
        className="repo-tree"
        style={{ height: "calc(100dvh - 15rem)", minHeight: "20rem" }}
      />
      {files.data?.truncated && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          Showing part of a large repository.
        </p>
      )}
    </div>
  );
}
