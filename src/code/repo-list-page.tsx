import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { BookMarked, GitBranch, GitPullRequestArrow, LoaderCircle, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
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
import { Textarea } from "@/components/ui/textarea";
import { api, responseJson } from "@/lib/api";
import { codeKeys, useRepositories } from "./code-api";
import { CopyField } from "./copy-field";

function CreateRepositoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const create = useMutation({
    mutationFn: async () => responseJson(
      await api.api.code.repos.$post({
        json: { name, description, defaultBranch },
      }),
    ),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: codeKeys.repositories });
      onOpenChange(false);
      navigate(`/git/${result.repository.name}`);
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
            <DialogTitle>New repository</DialogTitle>
            <DialogDescription>
              Names are shared across the workspace and form the clone URL.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="repo-name">Name</Label>
            <Input
              id="repo-name"
              autoFocus
              required
              placeholder="project"
              value={name}
              onChange={(event) => setName(event.target.value.toLowerCase())}
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="repo-description">Description</Label>
            <Textarea
              id="repo-description"
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="repo-branch">Default branch</Label>
            <Input
              id="repo-branch"
              required
              value={defaultBranch}
              onChange={(event) => setDefaultBranch(event.target.value)}
              className="font-mono"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}
              Create repository
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RepoListPage() {
  const repositories = useRepositories();
  const [creating, setCreating] = useState(false);
  const items = repositories.data?.repositories ?? [];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <h1 className="text-xl font-semibold tracking-[-0.02em]">Repositories</h1>
          <p className="text-sm text-muted-foreground">
            Clone with your account API token as the password.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus /> New repository
        </Button>
      </div>

      {repositories.isPending ? (
        <div className="grid min-h-40 place-items-center">
          <LoaderCircle className="animate-spin text-muted-foreground" />
        </div>
      ) : repositories.isError ? (
        <p className="text-sm text-destructive">{repositories.error.message}</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-surface p-10 text-center">
          <BookMarked className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 font-medium">No repositories yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create one, then push with any Git client.
          </p>
          <Button className="mt-4" onClick={() => setCreating(true)}>
            <Plus /> New repository
          </Button>
        </div>
      ) : (
        <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-surface">
          {items.map((repository) => (
            <li key={repository.name} className="flex flex-wrap items-center gap-4 px-5 py-4">
              <div className="min-w-0 flex-1">
                <Link
                  to={`/git/${repository.name}`}
                  className="font-mono text-[0.9375rem] font-semibold text-foreground hover:underline"
                >
                  {repository.name}
                </Link>
                {repository.description && (
                  <p className="mt-0.5 truncate text-sm text-muted-foreground">
                    {repository.description}
                  </p>
                )}
                <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <GitBranch className="size-3.5" />
                  {repository.defaultBranch}
                  <span aria-hidden="true">·</span>
                  <Link
                    to={`/git/${repository.name}/tasks`}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    <GitPullRequestArrow className="size-3.5" />
                    {repository.openTasks} open task{repository.openTasks === 1 ? "" : "s"}
                  </Link>
                  <span aria-hidden="true">·</span>
                  created {formatDistanceToNow(new Date(repository.createdAt), { addSuffix: true })}
                </p>
              </div>
              <CopyField value={repository.remote} label="Clone URL" className="w-full sm:w-96" />
            </li>
          ))}
        </ul>
      )}
      <CreateRepositoryDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
