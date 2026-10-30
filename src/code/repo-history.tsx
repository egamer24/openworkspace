import { format } from "date-fns";
import { FolderTree, GitCommitHorizontal, X } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { useCommit, useCommits } from "./code-api";
import { DiffList } from "./diff-view";
import {
  ErrorText,
  firstLine,
  Loading,
  Panel,
  PersonAvatar,
  relative,
  ShaButton,
  type RepoLinks,
} from "./repo-shared";

export function CommitsView({
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
  const commits = useCommits(repo, refName, path);
  if (commits.isPending) return <Loading />;
  if (commits.isError) return <ErrorText error={commits.error} />;
  const items = commits.data.pages.flatMap((page) => page.commits);
  const days = new Map<string, typeof items>();
  for (const commit of items) {
    const day = format(new Date(commit.committedAt), "MMM d, yyyy");
    days.set(day, [...days.get(day) ?? [], commit]);
  }

  return (
    <div className="space-y-4">
      {path && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          History for <span className="font-mono text-foreground">{path}</span>
          <Button variant="ghost" size="xs" nativeButton={false} render={<Link to={links.commits()} />}>
            <X /> Clear
          </Button>
        </p>
      )}
      {items.length === 0 ? (
        <Panel className="p-6 text-sm text-muted-foreground">
          No commits{path ? " changed this path in the scanned history" : " on this ref"}.
        </Panel>
      ) : (
        [...days].map(([day, dayCommits]) => (
          <section key={day} className="space-y-2">
            <h3 className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
              <GitCommitHorizontal className="size-4" /> Commits on {day}
            </h3>
            <Panel>
              <ul className="divide-y divide-border/60">
                {dayCommits.map((commit) => (
                  <li key={commit.hash} className="flex items-center gap-3 px-4 py-3">
                    <PersonAvatar person={{ name: commit.author.name }} className="hidden sm:flex" />
                    <div className="min-w-0 flex-1">
                      <Link
                        to={links.commit(commit.hash)}
                        className="block truncate text-sm font-medium hover:underline"
                      >
                        {firstLine(commit.message)}
                      </Link>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {commit.author.name} committed {relative(commit.committedAt)}
                      </p>
                    </div>
                    <ShaButton hash={commit.hash} />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      nativeButton={false} render={<Link to={links.tree("", commit.hash)} />}
                    >
                      <FolderTree />
                      <span className="sr-only">Browse files at this commit</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </Panel>
          </section>
        ))
      )}
      {commits.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={commits.isFetchingNextPage}
            onClick={() => void commits.fetchNextPage()}
          >
            {commits.isFetchingNextPage ? "Loading…" : "Load older commits"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function CommitView({ repo, hash, links }: { repo: string; hash: string; links: RepoLinks }) {
  const detail = useCommit(repo, hash);
  if (detail.isPending) return <Loading />;
  if (detail.isError) return <ErrorText error={detail.error} />;
  const { commit, files, truncated } = detail.data;
  const [title, ...body] = commit.message.split("\n");
  return (
    <div className="space-y-4">
      <Panel className="p-5">
        <div className="flex flex-wrap items-start gap-3">
          <h2 className="min-w-0 flex-1 text-lg font-semibold tracking-[-0.01em]">{title}</h2>
          <Button variant="outline" size="sm" nativeButton={false} render={<Link to={links.tree("", commit.hash)} />}>
            <FolderTree /> Browse files
          </Button>
        </div>
        {body.join("\n").trim() && (
          <pre className="mt-2 font-sans text-sm whitespace-pre-wrap text-muted-foreground">
            {body.join("\n").trim()}
          </pre>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <PersonAvatar person={{ name: commit.author.name }} className="size-5" />
            <span className="font-medium text-foreground">{commit.author.name}</span>
            committed {relative(commit.committedAt)}
          </span>
          <ShaButton hash={commit.hash} />
          {commit.parents.map((parent) => (
            <Link key={parent} to={links.commit(parent)} className="font-mono hover:underline">
              parent {parent.slice(0, 7)}
            </Link>
          ))}
        </div>
      </Panel>
      <DiffList
        files={files}
        truncated={truncated}
        fileLink={(path) => links.blob(path, commit.hash)}
        sides={{ repo, before: commit.parents[0] ?? null, after: commit.hash }}
      />
    </div>
  );
}
