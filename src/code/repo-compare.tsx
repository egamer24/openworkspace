import { ArrowLeft, GitPullRequestArrow } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTasks } from "@/tasks/tasks-api";
import { useCompare, useRefs } from "./code-api";
import { DiffList } from "./diff-view";
import {
  ErrorText,
  firstLine,
  Loading,
  Panel,
  relative,
  ShaButton,
  type RepoLinks,
} from "./repo-shared";

function RefSelect({
  repo,
  value,
  label,
  onChange,
}: {
  repo: string;
  value: string;
  label: string;
  onChange: (value: string) => void;
}) {
  const refs = useRefs(repo);
  const branches = refs.data?.refs.branches ?? [];
  const tags = refs.data?.refs.tags ?? [];
  return (
    <Select value={value} onValueChange={(next) => next && onChange(next)}>
      <SelectTrigger className="h-8 w-full font-mono text-xs sm:w-56" aria-label={label}>
        <span className="font-sans text-muted-foreground">{label}:</span>
        <SelectValue>{value || "choose"}</SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          <SelectLabel>Branches</SelectLabel>
          {branches.map((branch) => (
            <SelectItem key={branch.name} value={branch.name} className="font-mono text-xs">{branch.name}</SelectItem>
          ))}
        </SelectGroup>
        {tags.length > 0 && (
          <SelectGroup>
            <SelectLabel>Tags</SelectLabel>
            {tags.map((tag) => (
              <SelectItem key={tag.name} value={tag.name} className="font-mono text-xs">{tag.name}</SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
}

export function CompareView({
  repo,
  spec,
  defaultBranch,
  links,
}: {
  repo: string;
  spec: string;
  defaultBranch: string;
  links: RepoLinks;
}) {
  const navigate = useNavigate();
  const [rawBase = "", rawHead = ""] = spec.includes("...") ? spec.split("...") : ["", spec];
  const base = decodeURIComponent(rawBase) || defaultBranch;
  const head = decodeURIComponent(rawHead);
  const comparison = useCompare(repo, base, head || null);
  const tasks = useTasks(repo);
  const existing = tasks.data?.tasks.find((task) => task.branch === head);
  const go = (nextBase: string, nextHead: string) => navigate(links.compare(nextBase, nextHead));

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Compare changes</h2>
        <p className="text-sm text-muted-foreground">
          Shows what the head ref adds since it forked from the base, like a task or pull request would.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <RefSelect repo={repo} label="base" value={base} onChange={(next) => go(next, head || next)} />
        <ArrowLeft className="size-4 text-muted-foreground" />
        <RefSelect repo={repo} label="compare" value={head} onChange={(next) => go(base, next)} />
        {head && head !== base && (existing ? (
          <Button className="sm:ml-auto" variant="outline" size="sm" nativeButton={false} render={<Link to={links.task(existing.number)} />}>
            <GitPullRequestArrow /> Task #{existing.number}
          </Button>
        ) : (
          <Button className="sm:ml-auto" size="sm" nativeButton={false} render={<Link to={links.newTask(head)} />}>
            <GitPullRequestArrow /> Create task
          </Button>
        ))}
      </div>
      {!head ? (
        <Panel className="p-6 text-sm text-muted-foreground">Choose a branch to compare with {base}.</Panel>
      ) : comparison.isPending ? <Loading /> : comparison.isError ? (
        <ErrorText error={comparison.error} />
      ) : (
        <>
          <Panel className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-3 text-sm">
            <span><strong>{comparison.data.comparison.aheadBy}</strong> commits ahead</span>
            <span><strong>{comparison.data.comparison.behindBy}</strong> behind {base}</span>
            {comparison.data.comparison.mergeBase && (
              <span className="text-muted-foreground">
                fork point <span className="font-mono">{comparison.data.comparison.mergeBase.slice(0, 7)}</span>
              </span>
            )}
          </Panel>
          {comparison.data.comparison.commits.length > 0 && (
            <Panel>
              <ul className="divide-y divide-border/60">
                {comparison.data.comparison.commits.map((commit) => (
                  <li key={commit.hash} className="flex items-center gap-3 px-4 py-2.5">
                    <Link to={links.commit(commit.hash)} className="min-w-0 flex-1 truncate text-sm hover:underline">
                      {firstLine(commit.message)}
                    </Link>
                    <span className="hidden text-xs text-muted-foreground sm:inline">
                      {commit.author.name}, {relative(commit.committedAt)}
                    </span>
                    <ShaButton hash={commit.hash} />
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <DiffList
            files={comparison.data.comparison.files}
            truncated={comparison.data.comparison.truncated}
            fileLink={(path) => links.blob(path, head)}
            sides={{
              repo,
              before: comparison.data.comparison.mergeBase,
              after: comparison.data.comparison.headSha ?? head,
            }}
          />
        </>
      )}
    </div>
  );
}
