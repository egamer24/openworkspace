import {
  CheckCircle2,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock,
  FileDiff,
  Gavel,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestArrow,
  History,
  Layers,
  LoaderCircle,
  Lock,
  MessageSquare,
  MessageSquareWarning,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  Undo2,
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import {
  TASK_LEASE_MINUTES,
  type ReviewVerdict,
  type TaskAttempt,
  type TaskDetail,
  type TaskNoteKind,
  type TaskPerson,
} from "../../shared/tasks";
import { useAuth } from "@/auth/auth-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, responseJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useCompare, useRefs } from "@/code/code-api";
import { CopyField } from "@/code/copy-field";
import { DiffList } from "@/code/diff-view";
import { Markdown } from "@/code/markdown";
import {
  ErrorText,
  firstLine,
  Loading,
  Panel,
  PanelHeader,
  PersonAvatar,
  relative,
  ShaButton,
  type RepoLinks,
} from "@/code/repo-shared";
import { TaskForm, type TaskFormValues } from "./task-form";
import { leaseLabel, TaskStatusIcon } from "./task-list";
import {
  statusLabels,
  statusVariant,
  useMergeability,
  usePeople,
  useTask,
  useTaskMutation,
} from "./tasks-api";

const UNASSIGNED = "__unassigned__";

const attemptVariant: Record<TaskAttempt["status"], "info" | "success" | "secondary" | "warning" | "default"> = {
  active: "info",
  submitted: "success",
  released: "secondary",
  expired: "warning",
  merged: "default",
};

type Mutations = ReturnType<typeof useTaskActions>;

function useTaskActions(repo: string, number: number) {
  const param = { name: repo, number: String(number) };
  const tasks = api.api.code.repos[":name"].tasks[":number"];
  return {
    update: useTaskMutation(repo, number, async (json: Partial<TaskFormValues> & {
      status?: "open" | "closed";
      assigneeUserId?: string | null;
    }) => responseJson(await tasks.$patch({ param, json }))),
    claim: useTaskMutation(repo, number, async () =>
      responseJson(await tasks.attempts.$post({ param })), "Task claimed"),
    note: useTaskMutation(repo, number, async (json: { kind: TaskNoteKind; body: string }) =>
      responseJson(await tasks.notes.$post({ param, json }))),
    resolve: useTaskMutation(repo, number, async (input: { id: string; resolved: boolean }) =>
      responseJson(await tasks.notes[":noteId"].$patch({
        param: { ...param, noteId: input.id },
        json: { resolved: input.resolved },
      }))),
    review: useTaskMutation(repo, number, async (json: { verdict: ReviewVerdict; body: string }) =>
      responseJson(await tasks.reviews.$post({ param, json })), "Review submitted"),
    merge: useTaskMutation(repo, number, async (json: { bypassReview: boolean; deleteBranch: boolean }) =>
      responseJson(await tasks.merge.$post({ param, json })), "Merged"),
    renew: useTaskMutation(repo, number, async (attempt: number) =>
      responseJson(await tasks.attempts[":attempt"].lease.$post({
        param: { ...param, attempt: String(attempt) },
      })), "Lease renewed"),
    submit: useTaskMutation(repo, number, async (input: {
      attempt: number;
      headSha: string | null;
      summary: string | null;
    }) =>
      responseJson(await tasks.attempts[":attempt"].submit.$post({
        param: { ...param, attempt: String(input.attempt) },
        json: { headSha: input.headSha, summary: input.summary },
      })), "Result submitted"),
    release: useTaskMutation(repo, number, async (input: { attempt: number; summary: string }) =>
      responseJson(await tasks.attempts[":attempt"].release.$post({
        param: { ...param, attempt: String(input.attempt) },
        json: { summary: input.summary },
      })), "Task handed back"),
  };
}

function SideSection({ title, children, action }: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="space-y-2 border-b border-border/70 pb-4 last:border-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function TextDialog({
  title,
  description,
  submitLabel,
  withSha,
  pending,
  onClose,
  onSubmit,
}: {
  title: string;
  description: string;
  submitLabel: string;
  withSha?: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (values: { headSha: string | null; summary: string }) => void;
}) {
  const [headSha, setHeadSha] = useState("");
  const [summary, setSummary] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({ headSha: headSha.trim() || null, summary });
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="attempt-summary">Handoff summary</Label>
            <Textarea
              id="attempt-summary"
              rows={6}
              placeholder="What was done, decisions made, checks that ran, what remains"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </div>
          {withSha && (
            <div className="space-y-2">
              <Label htmlFor="attempt-sha">Commit SHA (optional)</Label>
              <Input
                id="attempt-sha"
                className="font-mono text-xs"
                placeholder="Defaults to the current tip of the attempt branch"
                value={headSha}
                onChange={(event) => setHeadSha(event.target.value)}
              />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={pending}>
              {pending && <LoaderCircle className="animate-spin" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Claim, lease and result controls for whoever works on the task. */
function WorkPanel({
  task,
  actions,
  branchExists,
}: {
  task: TaskDetail;
  actions: Mutations;
  branchExists: boolean;
}) {
  const auth = useAuth();
  const [dialog, setDialog] = useState<"submit" | "release" | null>(null);
  const current = task.attempts[0];
  const closed = task.status === "merged" || task.status === "closed";
  const mine = current && auth.user?.id === current.executor.id;
  const canClaim = !closed && !task.activeAttempt;
  if (closed) return null;

  return (
    <SideSection
      title="Work"
      action={canClaim && (
        <Button
          size="xs"
          disabled={actions.claim.isPending || task.blocked}
          onClick={() => actions.claim.mutate(undefined)}
        >
          {actions.claim.isPending ? <LoaderCircle className="animate-spin" /> : <Play />}
          {current ? "New attempt" : "Claim"}
        </Button>
      )}
    >
      {!current ? (
        <p className="text-sm text-muted-foreground">
          {task.blocked
            ? "Blocked until its dependencies merge."
            : `Claiming creates a branch from the current ${task.baseBranch} and a ${TASK_LEASE_MINUTES}-minute renewable lease.`}
        </p>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <PersonAvatar person={current.executor} className="size-5" />
            <span className="min-w-0 truncate font-medium">{current.executor.name}</span>
            <Badge variant={attemptVariant[current.status]}>{current.status}</Badge>
          </div>
          <p className="font-mono text-xs break-all text-muted-foreground">{current.branch}</p>
          {current.status === "active" && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="size-3.5" /> {leaseLabel(current.leaseExpiresAt)}
            </p>
          )}
          {mine && current.status === "active" && (
            <div className="space-y-2">
              <CopyField
                label="Start command"
                value={current.baseSha
                  ? `git fetch origin && git switch -c ${current.branch} ${current.baseSha}`
                  : `git switch -c ${current.branch}`}
              />
              <CopyField label="Push command" value={`git push -u origin ${current.branch}`} />
              {!branchExists && (
                <p className="text-xs text-muted-foreground">Nothing pushed to this branch yet.</p>
              )}
            </div>
          )}
          {mine && (current.status === "active" || current.status === "submitted") && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              <Button size="xs" onClick={() => setDialog("submit")}>
                <Send /> {current.status === "submitted" ? "Update result" : "Submit result"}
              </Button>
              {current.status === "active" && (
                <>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={actions.renew.isPending}
                    onClick={() => actions.renew.mutate(current.number)}
                  >
                    <RefreshCw /> Renew
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setDialog("release")}>
                    <Undo2 /> Hand back
                  </Button>
                </>
              )}
            </div>
          )}
          {!mine && current.status === "active" && (
            <p className="text-xs text-muted-foreground">
              Someone else can claim it when the lease lapses.
            </p>
          )}
        </div>
      )}
      {dialog === "submit" && current && (
        <TextDialog
          title={current.status === "submitted" ? "Update result" : "Submit result"}
          description={`Push ${current.branch} first. The result is pinned to that exact commit; reviews of older commits become outdated.`}
          submitLabel="Submit"
          withSha
          pending={actions.submit.isPending}
          onClose={() => setDialog(null)}
          onSubmit={({ headSha, summary }) => actions.submit.mutate(
            { attempt: current.number, headSha, summary: summary.trim() ? summary : null },
            { onSuccess: () => setDialog(null) },
          )}
        />
      )}
      {dialog === "release" && current && (
        <TextDialog
          title="Hand back task"
          description="The task returns to Open. Leave context for whoever picks it up next."
          submitLabel="Hand back"
          pending={actions.release.isPending}
          onClose={() => setDialog(null)}
          onSubmit={({ summary }) => actions.release.mutate(
            { attempt: current.number, summary },
            { onSuccess: () => setDialog(null) },
          )}
        />
      )}
    </SideSection>
  );
}

function MergeBox({ repo, task, actions }: { repo: string; task: TaskDetail; actions: Mutations }) {
  const submitted = task.attempts[0]?.status === "submitted" && Boolean(task.headSha);
  const open = task.status !== "merged" && task.status !== "closed";
  const mergeability = useMergeability(repo, task.number, open && submitted);
  const [deleteBranch, setDeleteBranch] = useState(true);

  if (task.merged) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/6 p-4">
        <GitMerge className="mt-0.5 size-5 text-primary" />
        <div className="text-sm">
          <p className="font-semibold">Merged into {task.baseBranch}</p>
          <p className="text-muted-foreground">
            {task.merged.by.name} fast-forwarded {task.baseBranch} to{" "}
            <span className="font-mono">{task.merged.sha.slice(0, 7)}</span> {relative(task.merged.at)}.
          </p>
        </div>
      </div>
    );
  }
  if (!open) return null;
  if (!submitted) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-border bg-surface p-4 text-sm">
        <GitPullRequestArrow className="mt-0.5 size-5 text-muted-foreground" />
        <div>
          <p className="font-semibold">Waiting for a result</p>
          <p className="text-muted-foreground">
            The executor pushes the attempt branch and submits a commit. Then it can be reviewed and merged.
          </p>
        </div>
      </div>
    );
  }
  const state = mergeability.data?.mergeability;
  return (
    <div className={cn(
      "overflow-hidden rounded-xl border bg-surface",
      state?.canMerge ? "border-success/40" : "border-border",
    )}>
      <ul className="divide-y divide-border/60">
        {mergeability.isPending ? (
          <li className="p-4"><Loading className="min-h-10" /></li>
        ) : mergeability.isError ? (
          <li className="p-4"><ErrorText error={mergeability.error} /></li>
        ) : state?.checks.map((check) => (
          <li key={check.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            {check.ok
              ? <CircleCheck className="size-4 shrink-0 text-success" />
              : <CircleAlert className="size-4 shrink-0 text-warning" />}
            <span className={cn(!check.ok && "font-medium")}>{check.label}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3 border-t border-border/70 bg-surface-sunken/60 px-4 py-3">
        <Button
          disabled={!state?.canMerge || actions.merge.isPending}
          onClick={() => actions.merge.mutate({ bypassReview: false, deleteBranch })}
        >
          {actions.merge.isPending ? <LoaderCircle className="animate-spin" /> : <GitMerge />}
          Fast-forward merge
        </Button>
        {state?.canBypassReview && (
          <Button
            variant="outline"
            disabled={actions.merge.isPending}
            onClick={() => actions.merge.mutate({ bypassReview: true, deleteBranch })}
          >
            Merge without review (admin)
          </Button>
        )}
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={deleteBranch} onCheckedChange={(value) => setDeleteBranch(Boolean(value))} />
          Delete task branch
        </label>
      </div>
    </div>
  );
}

function Event({ icon, person, children, at }: {
  icon: ReactNode;
  person?: TaskPerson;
  children: ReactNode;
  at: string;
}) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="mt-0.5 ml-1 grid size-6 shrink-0 place-items-center rounded-full bg-surface-sunken text-muted-foreground ring-4 ring-background">
        {icon}
      </span>
      <p className="min-w-0 flex-1 pt-0.5 text-muted-foreground">
        {person && <span className="font-medium text-foreground">{person.name} </span>}
        {children} <span className="text-xs">{relative(at)}</span>
      </p>
    </div>
  );
}

function Card({ person, header, children, tone }: {
  person: TaskPerson;
  header: ReactNode;
  children?: ReactNode;
  tone?: "question" | "decision" | "approve" | "changes";
}) {
  return (
    <div className="flex items-start gap-3">
      <PersonAvatar person={person} className="size-8 ring-4 ring-background" />
      <div
        className={cn(
          "min-w-0 flex-1 overflow-hidden rounded-xl border bg-surface",
          tone === "question" && "border-info/40",
          tone === "decision" && "border-primary/35",
          tone === "approve" && "border-success/40",
          tone === "changes" && "border-destructive/40",
          !tone && "border-border",
        )}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 bg-surface-sunken/50 px-3 py-2 text-xs text-muted-foreground">
          {header}
        </div>
        {children && <div className="px-4 py-3">{children}</div>}
      </div>
    </div>
  );
}

function Timeline({ task, actions, links }: { task: TaskDetail; actions: Mutations; links: RepoLinks }) {
  const items: Array<{ at: string; key: string; node: ReactNode }> = [];
  for (const attempt of task.attempts) {
    items.push({
      at: attempt.createdAt,
      key: `claim-${attempt.id}`,
      node: (
        <Event icon={<Play className="size-3.5" />} person={attempt.executor} at={attempt.createdAt}>
          started attempt {attempt.number} on <span className="font-mono">{attempt.branch}</span>
          {attempt.baseSha && <> from <span className="font-mono">{attempt.baseSha.slice(0, 7)}</span></>}
        </Event>
      ),
    });
    if (attempt.headSha && (attempt.status === "submitted" || attempt.status === "merged")) {
      items.push({
        at: attempt.updatedAt,
        key: `submit-${attempt.id}`,
        node: (
          <Card
            person={attempt.executor}
            header={(
              <>
                <Send className="size-3.5" />
                <span className="font-medium text-foreground">{attempt.executor.name}</span>
                submitted
                <Link to={links.commit(attempt.headSha)} className="font-mono hover:underline">
                  {attempt.headSha.slice(0, 7)}
                </Link>
                {!attempt.current && <Badge variant="outline">superseded attempt {attempt.number}</Badge>}
                <span>{relative(attempt.updatedAt)}</span>
              </>
            )}
          >
            {attempt.summary
              ? <Markdown source={attempt.summary} className="text-sm" />
              : <p className="text-sm text-muted-foreground">No handoff summary.</p>}
          </Card>
        ),
      });
    }
    if (attempt.status === "released") {
      items.push({
        at: attempt.updatedAt,
        key: `release-${attempt.id}`,
        node: (
          <Card
            person={attempt.executor}
            header={(
              <>
                <Undo2 className="size-3.5" />
                <span className="font-medium text-foreground">{attempt.executor.name}</span>
                handed the task back <span>{relative(attempt.updatedAt)}</span>
              </>
            )}
          >
            {attempt.summary
              ? <Markdown source={attempt.summary} className="text-sm" />
              : <p className="text-sm text-muted-foreground">No context left.</p>}
          </Card>
        ),
      });
    }
    if (attempt.status === "expired") {
      items.push({
        at: attempt.leaseExpiresAt,
        key: `expire-${attempt.id}`,
        node: (
          <Event icon={<Clock className="size-3.5" />} at={attempt.leaseExpiresAt}>
            The lease of attempt {attempt.number} ({attempt.executor.name}) lapsed
          </Event>
        ),
      });
    }
  }
  for (const note of task.notes) {
    const tone = note.kind === "question" ? "question" : note.kind === "decision" ? "decision" : undefined;
    const Icon = note.kind === "question" ? CircleHelp : note.kind === "decision" ? Gavel : MessageSquare;
    items.push({
      at: note.createdAt,
      key: note.id,
      node: (
        <Card
          person={note.author}
          tone={tone}
          header={(
            <>
              <Icon className="size-3.5" />
              <span className="font-medium text-foreground">{note.author.name}</span>
              {note.kind === "question" ? "asked" : note.kind === "decision" ? "recorded a decision" : "commented"}
              <span>{relative(note.createdAt)}</span>
              {note.kind === "question" && note.resolvedAt && <Badge variant="success">resolved</Badge>}
              {note.kind === "question" && (
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => actions.resolve.mutate({ id: note.id, resolved: !note.resolvedAt })}
                >
                  {note.resolvedAt ? <><RotateCcw /> Reopen</> : <><CheckCircle2 /> Resolve</>}
                </Button>
              )}
            </>
          )}
        >
          <Markdown source={note.body} className={cn("text-sm", note.resolvedAt && "opacity-60")} />
        </Card>
      ),
    });
  }
  const verdicts = {
    approve: { label: "approved", Icon: CircleCheck, color: "text-success", tone: "approve" },
    changes_requested: {
      label: "requested changes",
      Icon: MessageSquareWarning,
      color: "text-destructive",
      tone: "changes",
    },
    comment: { label: "reviewed", Icon: MessageSquare, color: "", tone: undefined },
  } as const;
  for (const review of task.reviews) {
    const { label, Icon, color, tone } = verdicts[review.verdict];
    items.push({
      at: review.createdAt,
      key: review.id,
      node: (
        <Card
          person={review.reviewer}
          tone={tone}
          header={(
            <>
              <Icon className={cn("size-3.5", color)} />
              <span className="font-medium text-foreground">{review.reviewer.name}</span>
              {label}
              <span className="font-mono">{review.headSha.slice(0, 7)}</span>
              <span>{relative(review.createdAt)}</span>
              {review.stale && <Badge variant="outline">outdated</Badge>}
            </>
          )}
        >
          {review.body ? <Markdown source={review.body} className="text-sm" /> : undefined}
        </Card>
      ),
    });
  }
  if (task.merged) {
    items.push({
      at: task.merged.at,
      key: "merged",
      node: (
        <Event icon={<GitMerge className="size-3.5 text-primary" />} person={task.merged.by} at={task.merged.at}>
          merged <span className="font-mono">{task.merged.sha.slice(0, 7)}</span> into{" "}
          <span className="font-mono">{task.baseBranch}</span>
        </Event>
      ),
    });
  }
  items.sort((left, right) => left.at.localeCompare(right.at));
  if (items.length === 0) return null;
  return (
    <div className="relative space-y-4 before:absolute before:top-2 before:bottom-2 before:left-4 before:w-px before:bg-border">
      {items.map((item) => <div key={item.key} className="relative">{item.node}</div>)}
    </div>
  );
}

const noteLabels: Record<TaskNoteKind, string> = {
  note: "Comment",
  decision: "Decision",
  question: "Blocking question",
};

function CommentForm({ actions }: { actions: Mutations }) {
  const [kind, setKind] = useState<TaskNoteKind>("note");
  const [body, setBody] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    actions.note.mutate({ kind, body }, { onSuccess: () => setBody("") });
  }
  return (
    <form onSubmit={submit} className="space-y-2 rounded-xl border border-border bg-surface p-3">
      <Textarea
        rows={4}
        placeholder="Comment, record an agreed decision, or ask a question that blocks merging. Markdown is supported."
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={kind} onValueChange={(value) => value && setKind(value as TaskNoteKind)}>
          <SelectTrigger className="h-8 w-44" aria-label="Kind">
            <SelectValue>{noteLabels[kind]}</SelectValue>
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {(Object.keys(noteLabels) as TaskNoteKind[]).map((value) => (
              <SelectItem key={value} value={value}>{noteLabels[value]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" className="ml-auto" disabled={actions.note.isPending || !body.trim()}>
          {actions.note.isPending && <LoaderCircle className="animate-spin" />} Post
        </Button>
      </div>
    </form>
  );
}

const reviewOptions: Array<[ReviewVerdict, string, string]> = [
  ["comment", "Comment", "General feedback without a verdict."],
  ["approve", "Approve", "This exact commit may be merged."],
  ["changes_requested", "Request changes", "Must be addressed before merging."],
];

function ReviewButton({ task, actions }: { task: TaskDetail; actions: Mutations }) {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<ReviewVerdict>("approve");
  const [body, setBody] = useState("");
  const current = task.attempts[0];
  if (!current || current.status !== "submitted" || !current.headSha) return null;
  const own = current.executor.id === auth.user?.id;
  const chosen = own ? "comment" : verdict;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <CircleCheck /> Review
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              actions.review.mutate({ verdict: chosen, body }, {
                onSuccess: () => {
                  setOpen(false);
                  setBody("");
                },
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Review {current.headSha.slice(0, 7)}</DialogTitle>
              <DialogDescription>
                The review applies to this exact commit. New commits make it outdated.
              </DialogDescription>
            </DialogHeader>
            <Textarea rows={5} placeholder="Leave a summary" value={body} onChange={(event) => setBody(event.target.value)} />
            <div className="space-y-2">
              {reviewOptions.map(([value, label, hint]) => {
                const disabled = own && value !== "comment";
                return (
                  <label
                    key={value}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border p-3 text-sm",
                      chosen === value ? "border-primary bg-primary/6" : "border-border",
                      disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                    )}
                  >
                    <input
                      type="radio"
                      name="verdict"
                      className="mt-1 accent-(--primary)"
                      disabled={disabled}
                      checked={chosen === value}
                      onChange={() => setVerdict(value)}
                    />
                    <span>
                      <span className="font-medium">{label}</span>
                      <span className="block text-muted-foreground">
                        {disabled ? "You cannot judge your own result." : hint}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={actions.review.isPending}>
                {actions.review.isPending && <LoaderCircle className="animate-spin" />} Submit review
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** What the task changes: base branch → current result, or the live branch tip. */
function taskRange(task: TaskDetail | undefined, branchExists: boolean) {
  if (!task) return { base: null, head: null };
  const current = task.attempts[0];
  if (task.merged) return { base: current?.baseSha ?? null, head: task.merged.sha };
  const head = task.headSha ?? (current && branchExists ? current.branch : null);
  return { base: task.baseBranch, head };
}

function AttemptsTab({ repo, task, links }: { repo: string; task: TaskDetail; links: RepoLinks }) {
  const withResults = task.attempts.filter((attempt) => attempt.headSha);
  const [left, setLeft] = useState(withResults[1]?.number ?? null);
  const [right, setRight] = useState(withResults[0]?.number ?? null);
  const leftAttempt = withResults.find((attempt) => attempt.number === left);
  const rightAttempt = withResults.find((attempt) => attempt.number === right);
  const comparison = useCompare(repo, leftAttempt?.headSha ?? null, rightAttempt?.headSha ?? null, true);
  const pick = (value: number | null, onChange: (value: number) => void, label: string) => (
    <Select value={value === null ? "" : String(value)} onValueChange={(next) => next && onChange(Number(next))}>
      <SelectTrigger className="h-8 w-48" aria-label={label}>
        <SelectValue>{value === null ? label : `Attempt ${value}`}</SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {withResults.map((attempt) => (
          <SelectItem key={attempt.number} value={String(attempt.number)}>
            Attempt {attempt.number} · {attempt.executor.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="space-y-5">
      <Panel>
        <ul className="divide-y divide-border/60">
          {task.attempts.map((attempt) => (
            <li key={attempt.id} className={cn("space-y-2 p-4", !attempt.current && "bg-surface-sunken/30")}>
              <div className="flex flex-wrap items-center gap-2">
                <PersonAvatar person={attempt.executor} />
                <span className="text-sm font-medium">{attempt.executor.name}</span>
                <span className="text-xs text-muted-foreground">attempt {attempt.number}</span>
                <Badge variant={attemptVariant[attempt.status]}>{attempt.status}</Badge>
                {!attempt.current && <Badge variant="outline">superseded</Badge>}
                <span className="ml-auto text-xs text-muted-foreground">
                  {attempt.status === "active" ? leaseLabel(attempt.leaseExpiresAt) : relative(attempt.updatedAt)}
                </span>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Branch</dt>
                <dd className="font-mono break-all">{attempt.branch}</dd>
                {attempt.baseSha && (
                  <>
                    <dt className="text-muted-foreground">Base</dt>
                    <dd className="font-mono">{attempt.baseSha.slice(0, 12)}</dd>
                  </>
                )}
                {attempt.headSha && (
                  <>
                    <dt className="text-muted-foreground">Result</dt>
                    <dd className="font-mono">
                      <Link to={links.commit(attempt.headSha)} className="hover:underline">
                        {attempt.headSha.slice(0, 12)}
                      </Link>
                    </dd>
                  </>
                )}
              </dl>
              {attempt.summary && (
                <div className="rounded-lg bg-surface-sunken p-3">
                  <Markdown source={attempt.summary} className="text-sm" />
                </div>
              )}
            </li>
          ))}
          {task.attempts.length === 0 && (
            <li className="p-6 text-sm text-muted-foreground">Nobody has claimed this task yet.</li>
          )}
        </ul>
      </Panel>
      {withResults.length >= 2 && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="mr-2 flex items-center gap-2 text-sm font-semibold">
              <Layers className="size-4" /> Compare alternative results
            </h3>
            {pick(left, setLeft, "From attempt")}
            <span className="text-muted-foreground">→</span>
            {pick(right, setRight, "To attempt")}
          </div>
          {comparison.isPending ? <Loading /> : comparison.isError ? <ErrorText error={comparison.error} /> : (
            <DiffList
              files={comparison.data.comparison.files}
              truncated={comparison.data.comparison.truncated}
              sides={leftAttempt?.headSha && rightAttempt?.headSha
                ? { repo, before: leftAttempt.headSha, after: rightAttempt.headSha }
                : undefined}
            />
          )}
        </div>
      )}
    </div>
  );
}

function DependencyList({ items, links, empty }: {
  items: TaskDetail["dependencies"];
  links: RepoLinks;
  empty: string;
}) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((item) => (
        <li key={item.number} className="flex items-center gap-2 text-sm">
          <TaskStatusIcon status={item.status} />
          <Link to={links.task(item.number)} className="min-w-0 flex-1 truncate hover:underline">
            <span className="text-muted-foreground">#{item.number}</span> {item.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Description({ task }: { task: TaskDetail }) {
  const sections: Array<[string, string, string | null]> = [
    ["Goal", task.goal, "No goal written yet."],
    ["Acceptance criteria", task.acceptanceCriteria, "No criteria yet."],
    ["Scope", task.scope, null],
  ];
  return (
    <Card
      person={task.createdBy}
      header={(
        <>
          <span className="font-medium text-foreground">{task.createdBy.name}</span>
          opened this task <span>{relative(task.createdAt)}</span>
        </>
      )}
    >
      <div className="space-y-5">
        {sections.map(([title, text, empty]) => (!text.trim() && empty === null) ? null : (
          <div key={title}>
            <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
            {text.trim() ? <Markdown source={text} /> : <p className="text-sm text-muted-foreground">{empty}</p>}
          </div>
        ))}
      </div>
    </Card>
  );
}

export function TaskPage({
  repo,
  number,
  tab,
  links,
}: {
  repo: string;
  number: number;
  tab: string;
  links: RepoLinks;
  remote: string;
}) {
  const task = useTask(repo, number);
  const people = usePeople(repo);
  const refs = useRefs(repo);
  const actions = useTaskActions(repo, number);
  const [editing, setEditing] = useState(false);
  const detail = task.data?.task;
  const current = detail?.attempts[0];
  const branchExists = Boolean(
    current && refs.data?.refs.branches.some((branch) => branch.name === current.branch),
  );
  const range = taskRange(detail, branchExists);
  const changes = useCompare(repo, range.base, range.head);

  if (task.isPending) return <Loading />;
  if (task.isError) return <ErrorText error={task.error} />;
  if (!detail) return null;
  const comparison = changes.data?.comparison;
  const changesLoading = changes.isPending && changes.fetchStatus !== "idle";
  const decisions = detail.notes.filter((note) => note.kind === "decision");
  const closed = detail.status === "merged" || detail.status === "closed";
  const tabs: Array<[string, string, typeof MessageSquare, number | undefined]> = [
    ["", "Conversation", MessageSquare, detail.notes.length + detail.reviews.length || undefined],
    ["commits", "Commits", GitCommitHorizontal, comparison?.commits.length],
    ["files", "Files changed", FileDiff, comparison?.files.length],
    ["attempts", "Attempts", History, detail.attempts.length || undefined],
  ];

  let summary: ReactNode;
  if (detail.merged) {
    summary = (
      <>
        <span className="font-medium text-foreground">{detail.merged.by.name}</span> merged into{" "}
        <span className="font-mono">{detail.baseBranch}</span> {relative(detail.merged.at)}
      </>
    );
  } else if (current && (current.status === "submitted" || current.status === "active")) {
    const count = comparison ? `${comparison.aheadBy} commit${comparison.aheadBy === 1 ? "" : "s"}` : "work";
    summary = (
      <>
        <span className="font-medium text-foreground">{current.executor.name}</span>{" "}
        {current.status === "submitted" ? "wants to merge" : "is working on"} {count} into{" "}
        <span className="font-mono">{detail.baseBranch}</span> from{" "}
        <span className="font-mono">{current.branch}</span>
      </>
    );
  } else {
    summary = (
      <>
        opened by {detail.createdBy.name} {relative(detail.createdAt)} · targets{" "}
        <span className="font-mono">{detail.baseBranch}</span>
      </>
    );
  }

  const noChanges = (
    <Panel className="p-6 text-sm text-muted-foreground">
      Nothing pushed for this task yet.
    </Panel>
  );

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-start gap-3">
          <h2 className="min-w-0 flex-1 text-2xl font-semibold tracking-[-0.02em]">
            {detail.title} <span className="font-normal text-muted-foreground">#{detail.number}</span>
          </h2>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}><Pencil /> Edit</Button>
          {!closed && <ReviewButton task={detail} actions={actions} />}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant={statusVariant[detail.status]} className="h-6 px-2.5 text-xs">
            <TaskStatusIcon status={detail.status} className="text-current" /> {statusLabels[detail.status]}
          </Badge>
          {detail.reviewState === "approved" && <Badge variant="success"><CircleCheck />approved</Badge>}
          {detail.reviewState === "changes_requested" && (
            <Badge variant="destructive"><MessageSquareWarning />changes requested</Badge>
          )}
          <span>{summary}</span>
        </div>
      </div>

      {detail.blocked && !closed && (
        <p className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-sm">
          <Lock className="size-4 text-warning" />
          Blocked until {detail.dependencies.filter((item) => item.status !== "merged")
            .map((item) => `#${item.number}`).join(", ")} merged.
        </p>
      )}

      <nav className="-mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0" aria-label="Task">
        {tabs.map(([id, label, Icon, count]) => (
          <Link
            key={id}
            to={links.task(detail.number, id)}
            className={cn(
              "-mb-px inline-flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium",
              tab === id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" /> {label}
            {count !== undefined && <Badge variant="secondary">{count}</Badge>}
          </Link>
        ))}
      </nav>

      {tab === "" && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="min-w-0 space-y-5">
            <Description task={detail} />
            {decisions.length > 0 && (
              <div className="rounded-xl border border-primary/25 bg-primary/6 p-4">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  <Gavel className="size-3.5" /> Agreed decisions
                </p>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {decisions.map((note) => <li key={note.id} className="whitespace-pre-wrap">{note.body}</li>)}
                </ul>
              </div>
            )}
            <Timeline task={detail} actions={actions} links={links} />
            <MergeBox repo={repo} task={detail} actions={actions} />
            <CommentForm actions={actions} />
          </div>

          <aside className="space-y-4">
            <WorkPanel task={detail} actions={actions} branchExists={branchExists} />
            <SideSection title="Assignee">
              <Select
                value={detail.assignee?.id ?? UNASSIGNED}
                onValueChange={(value) => actions.update.mutate({
                  assigneeUserId: !value || value === UNASSIGNED ? null : value,
                })}
              >
                <SelectTrigger className="h-8 w-full" aria-label="Assignee">
                  <SelectValue>{detail.assignee?.name ?? "Unassigned"}</SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                  {people.data?.people.map((person) => (
                    <SelectItem key={person.id} value={person.id}>{person.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SideSection>
            <SideSection title="Reviews">
              <ReviewSummary task={detail} />
            </SideSection>
            <SideSection title="Depends on">
              <DependencyList items={detail.dependencies} links={links} empty="No dependencies." />
            </SideSection>
            <SideSection title="Blocks">
              <DependencyList items={detail.dependents} links={links} empty="Nothing waits on this task." />
            </SideSection>
            {detail.status !== "merged" && (
              <SideSection title="State">
                {detail.status === "closed" ? (
                  <Button variant="outline" size="sm" onClick={() => actions.update.mutate({ status: "open" })}>
                    <RotateCcw /> Reopen task
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => actions.update.mutate({ status: "closed" })}>
                    <CircleX /> Close without merging
                  </Button>
                )}
              </SideSection>
            )}
          </aside>
        </div>
      )}

      {tab === "commits" && (changesLoading ? <Loading /> : changes.isError ? (
        <ErrorText error={changes.error} />
      ) : !comparison ? noChanges : (
        <Panel>
          <PanelHeader>
            <span className="text-muted-foreground">
              {comparison.aheadBy} commit{comparison.aheadBy === 1 ? "" : "s"}
              {comparison.behindBy > 0 && !detail.merged && ` · ${comparison.behindBy} behind ${detail.baseBranch}`}
            </span>
          </PanelHeader>
          <ul className="divide-y divide-border/60">
            {comparison.commits.map((commit) => (
              <li key={commit.hash} className="flex items-center gap-3 px-4 py-2.5">
                <GitCommitHorizontal className="size-4 shrink-0 text-muted-foreground" />
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
      ))}

      {tab === "files" && (changesLoading ? <Loading /> : changes.isError ? (
        <ErrorText error={changes.error} />
      ) : !comparison ? noChanges : (
        <div className="space-y-3">
          {!closed && current?.status === "submitted" && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm">
              <span className="flex-1 text-muted-foreground">
                Result <span className="font-mono text-foreground">{detail.headSha?.slice(0, 7)}</span>{" "}
                of attempt {current.number}
              </span>
              <ReviewButton task={detail} actions={actions} />
            </div>
          )}
          <DiffList
            files={comparison.files}
            truncated={comparison.truncated}
            fileLink={(path) => links.blob(path, comparison.headSha ?? undefined)}
            sides={comparison.headSha
              ? { repo, before: comparison.mergeBase, after: comparison.headSha }
              : undefined}
          />
        </div>
      ))}

      {tab === "attempts" && <AttemptsTab repo={repo} task={detail} links={links} />}

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit #{detail.number}</DialogTitle>
            <DialogDescription>Executors receive the goal, criteria, scope, and agreed decisions.</DialogDescription>
          </DialogHeader>
          {editing && (
            <TaskForm
              repo={repo}
              initial={detail}
              submitLabel="Save"
              pending={actions.update.isPending}
              onCancel={() => setEditing(false)}
              onSubmit={({ fromBranch: _unused, ...values }) =>
                actions.update.mutate(values, { onSuccess: () => setEditing(false) })}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReviewSummary({ task }: { task: TaskDetail }) {
  const latest = new Map<string, TaskDetail["reviews"][number]>();
  for (const review of task.reviews) {
    if (review.verdict !== "comment") latest.set(review.reviewer.id, review);
  }
  if (latest.size === 0) return <p className="text-sm text-muted-foreground">No reviews yet.</p>;
  return (
    <ul className="space-y-1.5 text-sm">
      {[...latest.values()].map((review) => (
        <li key={review.reviewer.id} className="flex items-center gap-2">
          <PersonAvatar person={review.reviewer} className="size-5" />
          <span className="min-w-0 flex-1 truncate">{review.reviewer.name}</span>
          {review.stale && <span className="text-xs text-muted-foreground">outdated</span>}
          {review.verdict === "approve"
            ? <CircleCheck className={cn("size-4", review.stale ? "text-muted-foreground" : "text-success")} />
            : <MessageSquareWarning className={cn("size-4", review.stale ? "text-muted-foreground" : "text-destructive")} />}
        </li>
      ))}
    </ul>
  );
}
