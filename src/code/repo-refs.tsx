import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  GitBranch,
  GitCompareArrows,
  GitPullRequestArrow,
  LoaderCircle,
  Plus,
  Search,
  Shield,
  Tag,
  Trash2,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import type { CodeBranch } from "../../shared/code";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, responseJson } from "@/lib/api";
import { useTasks } from "@/tasks/tasks-api";
import { codeKeys, useBranches, useTags } from "./code-api";
import {
  ErrorText,
  firstLine,
  Loading,
  Panel,
  relative,
  ShaButton,
  type RepoLinks,
} from "./repo-shared";

function AheadBehind({ branch }: { branch: CodeBranch }) {
  if (branch.isDefault) return <Badge variant="outline">default</Badge>;
  if (branch.aheadBy === null || branch.behindBy === null) {
    return <span className="text-xs text-muted-foreground">unrelated history</span>;
  }
  const max = Math.max(branch.aheadBy, branch.behindBy, 1);
  return (
    <div className="flex w-28 items-center gap-1 text-[11px] text-muted-foreground tabular-nums" title={`${branch.behindBy} behind, ${branch.aheadBy} ahead`}>
      <span className="w-6 text-right">{branch.behindBy}</span>
      <div className="flex h-1.5 flex-1">
        <div className="flex flex-1 justify-end border-r border-border">
          <div className="h-full rounded-l bg-muted-foreground/40" style={{ width: `${(branch.behindBy / max) * 100}%` }} />
        </div>
        <div className="flex-1">
          <div className="h-full rounded-r bg-primary/60" style={{ width: `${(branch.aheadBy / max) * 100}%` }} />
        </div>
      </div>
      <span className="w-6">{branch.aheadBy}</span>
    </div>
  );
}

function NewBranchDialog({
  repo,
  open,
  onOpenChange,
  defaultFrom,
}: {
  repo: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultFrom: string;
}) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [from, setFrom] = useState(defaultFrom);
  const create = useMutation({
    mutationFn: async () => responseJson(
      await api.api.code.repos[":name"].branches.$post({
        param: { name: repo },
        json: { name: name.trim(), from: from.trim() },
      }),
    ),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: codeKeys.branches(repo) }),
        client.invalidateQueries({ queryKey: codeKeys.refs(repo) }),
      ]);
      toast.success(`Branch ${name.trim()} created`);
      setName("");
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!create.isPending) create.mutate();
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New branch</DialogTitle>
            <DialogDescription>Creates the branch on the server from an existing ref or commit.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="branch-name">Name</Label>
            <Input id="branch-name" autoFocus required className="font-mono" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="branch-from">From</Label>
            <Input id="branch-from" required className="font-mono" value={from} onChange={(event) => setFrom(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />} Create branch
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BranchesView({ repo, links }: { repo: string; links: RepoLinks }) {
  const branches = useBranches(repo);
  const tasks = useTasks(repo);
  const client = useQueryClient();
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<CodeBranch | null>(null);
  const remove = useMutation({
    mutationFn: async (branch: string) => responseJson(
      await api.api.code.repos[":name"].branches.$delete({
        param: { name: repo },
        query: { branch },
      }),
    ),
    onSuccess: async (_, branch) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: codeKeys.branches(repo) }),
        client.invalidateQueries({ queryKey: codeKeys.refs(repo) }),
      ]);
      toast.success(`Branch ${branch} deleted`);
      setDeleting(null);
    },
    onError: (error) => toast.error(error.message),
  });

  if (branches.isPending) return <Loading />;
  if (branches.isError) return <ErrorText error={branches.error} />;
  const taskByBranch = new Map(
    (tasks.data?.tasks ?? []).filter((task) => task.branch).map((task) => [task.branch!, task]),
  );
  const needle = filter.trim().toLowerCase();
  const items = branches.data.branches.filter((branch) => branch.name.toLowerCase().includes(needle));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search branches" className="h-9 pl-8" value={filter} onChange={(event) => setFilter(event.target.value)} />
        </div>
        <Button className="ml-auto" onClick={() => setCreating(true)}><Plus /> New branch</Button>
      </div>
      <Panel>
        {items.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No branches{needle ? " match" : " yet"}.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {items.map((branch) => {
              const task = taskByBranch.get(branch.name);
              return (
                <li key={branch.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <div className="min-w-0 flex-1 basis-60">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={links.tree("", branch.name)} className="truncate font-mono text-sm font-medium text-primary hover:underline">
                        {branch.name}
                      </Link>
                      {branch.protected && <Badge variant="secondary"><Shield />protected</Badge>}
                      {task && (
                        <Link to={links.task(task.number)}>
                          <Badge variant="info"><GitPullRequestArrow />#{task.number}</Badge>
                        </Link>
                      )}
                    </div>
                    {branch.commit && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        Updated {relative(branch.commit.committedAt)} by {branch.commit.author.name}
                        {" · "}
                        <Link to={links.commit(branch.hash)} className="hover:underline">{firstLine(branch.commit.message)}</Link>
                      </p>
                    )}
                  </div>
                  <AheadBehind branch={branch} />
                  <div className="flex items-center gap-1">
                    <ShaButton hash={branch.hash} />
                    {!branch.isDefault && (
                      <>
                        <Button variant="ghost" size="icon-xs" nativeButton={false} render={<Link to={links.compare(branches.data.defaultBranch, branch.name)} />}>
                          <GitCompareArrows />
                          <span className="sr-only">Compare</span>
                        </Button>
                        {!task && (
                          <Button variant="ghost" size="xs" nativeButton={false} render={<Link to={links.newTask(branch.name)} />}>
                            <GitPullRequestArrow /> Task
                          </Button>
                        )}
                        <Button variant="ghost" size="icon-xs" className="text-destructive" onClick={() => setDeleting(branch)}>
                          <Trash2 />
                          <span className="sr-only">Delete {branch.name}</span>
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      <NewBranchDialog repo={repo} open={creating} onOpenChange={setCreating} defaultFrom={branches.data.defaultBranch} />
      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The branch ref is removed. Commits stay reachable from tasks and other branches that contain them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.name)}
            >
              Delete branch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function TagsView({ repo, links }: { repo: string; links: RepoLinks }) {
  const tags = useTags(repo);
  if (tags.isPending) return <Loading />;
  if (tags.isError) return <ErrorText error={tags.error} />;
  return (
    <Panel>
      {tags.data.tags.length === 0 ? (
        <div className="p-8 text-center">
          <Tag className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No tags yet</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">git tag v1.0.0 && git push origin v1.0.0</p>
        </div>
      ) : (
        <ul className="divide-y divide-border/60">
          {tags.data.tags.map((tag) => (
            <li key={tag.name} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Tag className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <Link to={links.tree("", tag.name)} className="font-mono text-sm font-medium text-primary hover:underline">
                  {tag.name}
                </Link>
                {tag.commit && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {relative(tag.commit.committedAt)} · {firstLine(tag.commit.message)}
                  </p>
                )}
              </div>
              {tag.commit && <ShaButton hash={tag.commit.hash} />}
              <Button variant="ghost" size="xs" nativeButton={false} render={<Link to={links.tree("", tag.name)} />}>
                <GitBranch /> Browse
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
