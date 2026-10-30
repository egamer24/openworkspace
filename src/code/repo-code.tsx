import {
  BookOpen,
  Code2,
  Copy,
  Download,
  Eye,
  File,
  FileCode2,
  Folder,
  GitCommitHorizontal,
  History,
  Link2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import type { CodeCommit } from "../../shared/code";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd } from "./kbd";
import { cn } from "@/lib/utils";
import {
  rawFileUrl,
  useBlob,
  useEntryCommits,
  useFileIndex,
  useTree,
} from "./code-api";
import { CodeFile } from "./pierre";

type LineSelection = { start: number; end: number };
import { Markdown } from "./markdown";
import {
  copyText,
  ErrorText,
  firstLine,
  formatBytes,
  Loading,
  Panel,
  PanelHeader,
  relative,
  type RepoLinks,
} from "./repo-shared";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);

function extension(path: string) {
  const name = path.split("/").at(-1) ?? "";
  return name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
}

export function isMarkdown(path: string) {
  return ["md", "markdown", "mdx"].includes(extension(path));
}

function isImage(path: string) {
  return IMAGE_EXTENSIONS.has(extension(path));
}

export function Breadcrumbs({
  repo,
  path,
  links,
}: {
  repo: string;
  path: string;
  links: RepoLinks;
}) {
  const parts = path.split("/").filter(Boolean);
  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-sm" aria-label="Path">
      <Link to={links.tree("")} className="font-semibold text-primary hover:underline">{repo}</Link>
      {parts.map((part, index) => {
        const target = parts.slice(0, index + 1).join("/");
        const last = index === parts.length - 1;
        return (
          <span key={target} className="flex items-center gap-1">
            <span className="text-muted-foreground">/</span>
            {last
              ? <span className="font-semibold">{part}</span>
              : <Link to={links.tree(target)} className="text-primary hover:underline">{part}</Link>}
          </span>
        );
      })}
    </nav>
  );
}

function CommitBar({
  commit,
  links,
  historyPath,
}: {
  commit: CodeCommit;
  links: RepoLinks;
  historyPath: string;
}) {
  return (
    <PanelHeader>
      <span className="shrink-0 font-medium">{commit.author.name}</span>
      <Link
        to={links.commit(commit.hash)}
        className="min-w-0 flex-1 truncate text-muted-foreground hover:text-foreground hover:underline"
      >
        {firstLine(commit.message)}
      </Link>
      <Link
        to={links.commit(commit.hash)}
        className="hidden shrink-0 font-mono text-xs text-muted-foreground hover:underline sm:inline"
      >
        {commit.hash.slice(0, 7)}
      </Link>
      <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
        {relative(commit.committedAt)}
      </span>
      <Button variant="ghost" size="xs" nativeButton={false} render={<Link to={links.commits(historyPath)} />}>
        <History /> History
      </Button>
    </PanelHeader>
  );
}

function EmptyRepository({ remote, branch }: { remote: string; branch: string }) {
  const steps = [
    {
      title: "Push an existing repository",
      commands: [`git remote add origin ${remote}`, `git push -u origin ${branch}`],
    },
    {
      title: "Or start a new one",
      commands: [
        `git init -b ${branch}`,
        "git commit --allow-empty -m \"Initial commit\"",
        `git remote add origin ${remote}`,
        `git push -u origin ${branch}`,
      ],
    },
  ];
  return (
    <Panel className="space-y-5 p-6">
      <div>
        <p className="font-medium">This repository is empty</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Use any username and an account API token from Settings → MCP as the password.
          A credential helper keeps it for later pushes.
        </p>
      </div>
      {steps.map((step) => (
        <div key={step.title}>
          <p className="mb-2 text-sm font-medium">{step.title}</p>
          <div className="relative">
            <pre className="overflow-x-auto rounded-lg bg-surface-sunken p-4 pr-12 font-mono text-xs leading-5">
              {step.commands.join("\n")}
            </pre>
            <Button
              variant="ghost"
              size="icon-xs"
              className="absolute top-2 right-2"
              onClick={() => void copyText(step.commands.join("\n"), "Commands")}
            >
              <Copy />
              <span className="sr-only">Copy commands</span>
            </Button>
          </div>
        </div>
      ))}
    </Panel>
  );
}

export function TreeView({
  repo,
  refName,
  path,
  links,
  remote,
}: {
  repo: string;
  refName: string;
  path: string;
  links: RepoLinks;
  remote: string;
}) {
  const tree = useTree(repo, refName, path);
  const hasCommit = Boolean(tree.data?.tree.commit);
  const lastCommits = useEntryCommits(repo, refName, path, hasCommit);
  if (tree.isPending) return <Loading />;
  if (tree.isError) return <ErrorText error={tree.error} />;
  const { commit, entries } = tree.data.tree;
  if (!commit) return <EmptyRepository remote={remote} branch={refName} />;
  const readme = entries.find((entry) =>
    entry.type !== "tree" && /^readme(\.(md|markdown|txt|rst))?$/iu.test(entry.name)
  );
  const join = (name: string) => (path ? `${path}/${name}` : name);
  const commits = lastCommits.data?.commits ?? {};
  return (
    <div className="space-y-4">
      <Panel>
        <CommitBar commit={commit} links={links} historyPath={path} />
        <table className="w-full table-fixed text-sm">
          <tbody className="divide-y divide-border/60">
            {path && (
              <tr className="hover:bg-accent/50">
                <td colSpan={3}>
                  <Link
                    to={links.tree(path.split("/").slice(0, -1).join("/"))}
                    className="flex items-center gap-3 px-4 py-2"
                  >
                    <Folder className="size-4 text-primary" />
                    ..
                  </Link>
                </td>
              </tr>
            )}
            {entries.map((entry) => {
              const directory = entry.type === "tree";
              const target = directory ? links.tree(join(entry.name)) : links.blob(join(entry.name));
              const last = commits[entry.name];
              return (
                <tr key={entry.name} className="hover:bg-accent/50">
                  <td className="w-[45%] py-2 pl-4 sm:w-[35%]">
                    {entry.type === "gitlink" ? (
                      <span className="flex items-center gap-3 text-muted-foreground">
                        <GitCommitHorizontal className="size-4 shrink-0" />
                        <span className="truncate">{entry.name}</span>
                        <span className="font-mono text-xs">@ {entry.hash.slice(0, 7)}</span>
                      </span>
                    ) : (
                      <Link to={target} className="flex min-w-0 items-center gap-3 hover:underline">
                        {directory
                          ? <Folder className="size-4 shrink-0 fill-primary/20 text-primary" />
                          : <File className="size-4 shrink-0 text-muted-foreground" />}
                        <span className="truncate">{entry.name}</span>
                      </Link>
                    )}
                  </td>
                  <td className="truncate px-4 py-2 text-muted-foreground">
                    {last ? (
                      <Link to={links.commit(last.hash)} className="hover:text-foreground hover:underline">
                        {firstLine(last.message)}
                      </Link>
                    ) : lastCommits.isPending ? (
                      <span className="inline-block h-3 w-40 max-w-full animate-pulse rounded bg-muted" />
                    ) : null}
                  </td>
                  <td className="hidden w-32 py-2 pr-4 text-right text-xs text-muted-foreground sm:table-cell">
                    {last ? relative(last.committedAt) : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
      {readme && (
        <ReadmePanel repo={repo} refName={refName} path={join(readme.name)} />
      )}
    </div>
  );
}

function ReadmePanel({ repo, refName, path }: { repo: string; refName: string; path: string }) {
  const blob = useBlob(repo, refName, path);
  return (
    <Panel>
      <PanelHeader>
        <BookOpen className="size-4 text-muted-foreground" />
        <span className="font-medium">{path.split("/").at(-1)}</span>
      </PanelHeader>
      <div className="p-6">
        {blob.isPending ? <Loading className="min-h-20" /> : blob.isError ? (
          <ErrorText error={blob.error} />
        ) : blob.data.blob.text === null ? (
          <p className="text-sm text-muted-foreground">README is not displayable.</p>
        ) : isMarkdown(path) ? (
          <Markdown source={blob.data.blob.text} context={{ repo, ref: refName, path }} />
        ) : (
          <pre className="text-sm whitespace-pre-wrap">{blob.data.blob.text}</pre>
        )}
      </div>
    </Panel>
  );
}

function parseSelection(hash: string): LineSelection | null {
  const match = hash.match(/^#L(\d+)(?:-L?(\d+))?$/u);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function selectionHash(selection: LineSelection | null) {
  if (!selection) return "";
  return selection.start === selection.end
    ? `#L${selection.start}`
    : `#L${selection.start}-L${selection.end}`;
}

export function BlobView({
  repo,
  refName,
  path,
  links,
}: {
  repo: string;
  refName: string;
  path: string;
  links: RepoLinks;
}) {
  const blob = useBlob(repo, refName, path);
  const location = useLocation();
  const navigate = useNavigate();
  const selection = parseSelection(location.hash);
  const markdown = isMarkdown(path);
  const [preview, setPreview] = useState(true);

  if (blob.isPending) return <Loading />;
  if (blob.isError) return <ErrorText error={blob.error} />;
  const file = blob.data.blob;
  const lines = file.text?.replace(/\n$/u, "").split("\n") ?? [];
  const showPreview = markdown && preview && file.kind === "text";
  const permalink = `${window.location.origin}/git/${repo}/blob/${path.split("/").map(encodeURIComponent).join("/")}?ref=${file.commit.hash}${selectionHash(selection)}`;

  function select(range: LineSelection | null) {
    const next = range
      ? { start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) }
      : null;
    navigate(`${location.pathname}${location.search}${selectionHash(next)}`, {
      replace: true,
      preventScrollReset: true,
    });
  }

  return (
    <Panel>
      <CommitBar commit={file.commit} links={links} historyPath={path} />
      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-3 py-1.5 text-xs text-muted-foreground">
        {markdown && file.kind === "text" && (
          <div className="inline-flex rounded-lg border border-border p-0.5">
            <Button size="xs" variant={preview ? "secondary" : "ghost"} onClick={() => setPreview(true)}>
              <Eye /> Preview
            </Button>
            <Button size="xs" variant={preview ? "ghost" : "secondary"} onClick={() => setPreview(false)}>
              <Code2 /> Code
            </Button>
          </div>
        )}
        {file.kind === "text" && <span>{lines.length} lines</span>}
        <span>{formatBytes(file.size)}</span>
        <div className="ml-auto flex items-center gap-0.5">
          {file.kind === "text" && (
            <Button variant="ghost" size="xs" onClick={() => void copyText(file.text ?? "", "File contents")}>
              <Copy /> <span className="hidden sm:inline">Copy</span>
            </Button>
          )}
          <Button variant="ghost" size="xs" onClick={() => void copyText(permalink, "Permalink")}>
            <Link2 /> <span className="hidden sm:inline">Permalink</span>
          </Button>
          <Button variant="ghost" size="xs" nativeButton={false} render={<a href={rawFileUrl(repo, refName, path)} />}>
            <Download /> <span className="hidden sm:inline">Download</span>
          </Button>
        </div>
      </div>
      {showPreview ? (
        <div className="p-6">
          <Markdown source={file.text ?? ""} context={{ repo, ref: refName, path }} />
        </div>
      ) : file.kind === "text" ? (
        <CodeFile
          path={path}
          contents={file.text ?? ""}
          cacheKey={file.hash}
          selectedLines={selection}
          onSelectLines={select}
        />
      ) : isImage(path) ? (
        <div className="grid place-items-center bg-[repeating-conic-gradient(var(--surface-sunken)_0%_25%,transparent_0%_50%)] bg-size-[16px_16px] p-6">
          <img
            src={rawFileUrl(repo, refName, path, true)}
            alt={path.split("/").at(-1)}
            className="max-h-[70dvh] max-w-full"
          />
        </div>
      ) : (
        <p className="p-6 text-sm text-muted-foreground">
          {file.kind === "binary" ? "Binary file." : "File is too large to display."}{" "}
          Use Download to get it.
        </p>
      )}
    </Panel>
  );
}

function fuzzyScore(path: string, query: string) {
  const haystack = path.toLowerCase();
  const name = haystack.split("/").at(-1) ?? haystack;
  if (name.startsWith(query)) return 1_000 - path.length;
  const inName = name.indexOf(query);
  if (inName >= 0) return 800 - inName - path.length / 10;
  const inPath = haystack.indexOf(query);
  if (inPath >= 0) return 500 - inPath / 2 - path.length / 10;
  let position = 0;
  for (const character of query) {
    position = haystack.indexOf(character, position);
    if (position < 0) return -1;
    position += 1;
  }
  return 100 - path.length / 10;
}

/** "Go to file" finder over every path at the ref; opens with `t`. */
export function FileFinder({
  repo,
  refName,
  links,
}: {
  repo: string;
  refName: string;
  links: RepoLinks;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const files = useFileIndex(repo, refName, open);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (event.key === "t" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(() => {
    const paths = files.data?.paths ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return paths.slice(0, 50);
    return paths
      .map((path) => ({ path, score: fuzzyScore(path, needle) }))
      .filter((item) => item.score >= 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 50)
      .map((item) => item.path);
  }, [files.data, query]);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="text-muted-foreground">
        <FileCode2 /> Go to file <Kbd className="hidden sm:inline-flex">t</Kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
        title="Go to file"
        description="Search files in this repository"
      >
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search files…" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-96">
            {files.isPending ? (
              <Loading className="min-h-24" />
            ) : (
              <CommandEmpty>No matching files.</CommandEmpty>
            )}
            {results.map((path) => (
              <CommandItem
                key={path}
                value={path}
                onSelect={() => {
                  setOpen(false);
                  setQuery("");
                  navigate(links.blob(path));
                }}
              >
                <File className="text-muted-foreground" />
                <span className="truncate font-mono text-xs">{path}</span>
              </CommandItem>
            ))}
          </CommandList>
          {files.data?.truncated && (
            <p className={cn("border-t border-border px-3 py-2 text-xs text-muted-foreground")}>
              Large repository: only part of the file list is searchable.
            </p>
          )}
        </Command>
      </CommandDialog>
    </>
  );
}
