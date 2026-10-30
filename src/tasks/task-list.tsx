import {
  CircleCheck,
  CircleDot,
  CircleHelp,
  CircleX,
  Clock,
  GitMerge,
  GitPullRequestArrow,
  Lock,
  MessageSquareWarning,
  Plus,
  Search,
} from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { TaskStatus, TaskSummary } from "../../shared/tasks";
import { useAuth } from "@/auth/auth-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ErrorText,
  Loading,
  Panel,
  PersonAvatar,
  relative,
  type RepoLinks,
} from "@/code/repo-shared";
import { statusLabels, useTasks } from "./tasks-api";

type Filter = "open" | "review" | "mine" | "merged" | "closed" | "all";

const filters: Array<[Filter, string]> = [
  ["open", "Open"],
  ["review", "Needs review"],
  ["mine", "Mine"],
  ["merged", "Merged"],
  ["closed", "Closed"],
  ["all", "All"],
];

const OPEN: TaskStatus[] = ["open", "in_progress", "in_review"];

export function leaseLabel(expiresAt: string) {
  const minutes = Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000);
  return minutes > 0 ? `lease ${minutes} min` : "lease lapsed";
}

export function TaskStatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const icons = {
    open: [CircleDot, "text-success"],
    in_progress: [Clock, "text-info"],
    in_review: [GitPullRequestArrow, "text-warning"],
    merged: [GitMerge, "text-primary"],
    closed: [CircleX, "text-muted-foreground"],
  } as const;
  const [Icon, color] = icons[status];
  return <Icon className={cn("size-4 shrink-0", color, className)} aria-label={statusLabels[status]} />;
}

function matches(task: TaskSummary, filter: Filter, userId: string | undefined) {
  switch (filter) {
    case "open":
      return OPEN.includes(task.status);
    case "review":
      return task.status === "in_review";
    case "mine":
      return OPEN.includes(task.status)
        && (task.assignee?.id === userId || task.createdBy.id === userId);
    case "merged":
      return task.status === "merged";
    case "closed":
      return task.status === "closed";
    default:
      return true;
  }
}

function TaskRow({ task, links }: { task: TaskSummary; links: RepoLinks }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3 hover:bg-accent/40">
      <TaskStatusIcon status={task.status} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link to={links.task(task.number)} className="font-medium hover:text-primary hover:underline">
            {task.title}
          </Link>
          {task.blocked && (
            <Badge variant="warning">
              <Lock />blocked by {task.dependsOn.map((number) => `#${number}`).join(", ")}
            </Badge>
          )}
          {task.openQuestions > 0 && (
            <Badge variant="info"><CircleHelp />{task.openQuestions} question{task.openQuestions === 1 ? "" : "s"}</Badge>
          )}
          {task.status === "in_review" && task.reviewState === "approved" && (
            <Badge variant="success"><CircleCheck />approved</Badge>
          )}
          {task.status === "in_review" && task.reviewState === "changes_requested" && (
            <Badge variant="destructive"><MessageSquareWarning />changes requested</Badge>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          #{task.number} · {statusLabels[task.status].toLowerCase()} · opened {relative(task.createdAt)} by {task.createdBy.name}
          {task.branch && (
            <>
              {" · "}
              <span className="font-mono">{task.branch}</span> → <span className="font-mono">{task.baseBranch}</span>
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {task.activeAttempt && (
          <span className="hidden items-center gap-1 text-xs text-muted-foreground md:flex">
            <Clock className="size-3.5" /> {leaseLabel(task.activeAttempt.leaseExpiresAt)}
          </span>
        )}
        {task.assignee && <PersonAvatar person={task.assignee} />}
      </div>
    </li>
  );
}

export function TaskList({ repo, links }: { repo: string; links: RepoLinks }) {
  const auth = useAuth();
  const tasks = useTasks(repo);
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = (searchParams.get("filter") as Filter | null) ?? "open";
  const [query, setQuery] = useState("");

  if (tasks.isPending) return <Loading />;
  if (tasks.isError) return <ErrorText error={tasks.error} />;
  const all = tasks.data.tasks;
  const needle = query.trim().toLowerCase();
  const items = all.filter((task) =>
    matches(task, filter, auth.user?.id)
    && (!needle || task.title.toLowerCase().includes(needle) || `#${task.number}` === needle)
  );
  const count = (value: Filter) => all.filter((task) => matches(task, value, auth.user?.id)).length;
  const attention = all.filter((task) =>
    OPEN.includes(task.status)
    && (task.openQuestions > 0 || (task.status === "in_review" && task.reviewState !== "changes_requested"))
  );

  return (
    <div className="space-y-4">
      {attention.length > 0 && filter === "open" && (
        <div className="rounded-xl border border-warning/30 bg-warning/8 px-4 py-3 text-sm">
          <p className="font-semibold">Needs your attention</p>
          <ul className="mt-1 space-y-0.5">
            {attention.slice(0, 5).map((task) => (
              <li key={task.number}>
                <Link to={links.task(task.number)} className="hover:underline">
                  <span className="text-muted-foreground">#{task.number}</span> {task.title}
                </Link>
                <span className="text-muted-foreground">
                  {" — "}
                  {[
                    task.openQuestions > 0 ? `${task.openQuestions} open question${task.openQuestions === 1 ? "" : "s"}` : null,
                    task.status === "in_review" ? "result ready for review" : null,
                  ].filter(Boolean).join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search tasks" className="h-9 pl-8" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <Button className="ml-auto" nativeButton={false} render={<Link to={links.newTask()} />}>
          <Plus /> New task
        </Button>
      </div>
      <Panel>
        <div className="flex gap-1 overflow-x-auto border-b border-border/70 bg-surface-sunken/60 px-2 py-1.5">
          {filters.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                const params = new URLSearchParams(searchParams);
                if (value === "open") params.delete("filter");
                else params.set("filter", value);
                setSearchParams(params, { replace: true });
              }}
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm",
                filter === value ? "bg-surface font-medium shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
              <span className="text-xs tabular-nums text-muted-foreground">{count(value)}</span>
            </button>
          ))}
        </div>
        {items.length === 0 ? (
          <div className="p-10 text-center">
            <GitPullRequestArrow className="mx-auto size-7 text-muted-foreground" />
            <p className="mt-2 font-medium">{all.length === 0 ? "No tasks yet" : "Nothing here"}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Tasks describe a change. People and agents claim them, push a branch, and submit for review.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {items.map((task) => <TaskRow key={task.number} task={task} links={links} />)}
          </ul>
        )}
      </Panel>
    </div>
  );
}
