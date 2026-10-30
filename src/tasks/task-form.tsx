import { LoaderCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
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
import { useRefs } from "@/code/code-api";

export type TaskFormValues = {
  title: string;
  goal: string;
  acceptanceCriteria: string;
  scope: string;
  baseBranch: string | null;
  dependsOn: number[];
};

const NONE = "__none__";

export function parseTaskNumbers(value: string) {
  return [...new Set(
    value
      .split(/[\s,]+/u)
      .map((item) => Number(item.replace(/^#/u, "")))
      .filter((item) => Number.isSafeInteger(item) && item > 0),
  )];
}

/**
 * Task fields shared by creation and editing. Goal and criteria accept
 * Markdown; executors receive them together with the agreed decisions.
 */
export function TaskForm({
  repo,
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
  withBranch = false,
  initialBranch = null,
}: {
  repo: string;
  initial?: Partial<TaskFormValues>;
  submitLabel: string;
  pending: boolean;
  onSubmit: (values: TaskFormValues & { fromBranch: string | null }) => void;
  onCancel: () => void;
  withBranch?: boolean;
  initialBranch?: string | null;
}) {
  const refs = useRefs(repo);
  const branches = refs.data?.refs.branches ?? [];
  const defaultBranch = refs.data?.refs.defaultBranch ?? "main";
  const [values, setValues] = useState({
    title: initial?.title ?? "",
    goal: initial?.goal ?? "",
    acceptanceCriteria: initial?.acceptanceCriteria ?? "",
    scope: initial?.scope ?? "",
    baseBranch: initial?.baseBranch ?? null,
    dependsOn: (initial?.dependsOn ?? []).map((number) => `#${number}`).join(", "),
    fromBranch: initialBranch,
  });
  const set = <K extends keyof typeof values>(key: K) => (value: (typeof values)[K]) =>
    setValues((current) => ({ ...current, [key]: value }));
  const base = values.baseBranch ?? defaultBranch;

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({
      title: values.title.trim(),
      goal: values.goal,
      acceptanceCriteria: values.acceptanceCriteria,
      scope: values.scope,
      baseBranch: values.baseBranch,
      dependsOn: parseTaskNumbers(values.dependsOn),
      fromBranch: withBranch ? values.fromBranch : null,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="task-title">Title</Label>
        <Input
          id="task-title"
          autoFocus
          required
          value={values.title}
          onChange={(event) => set("title")(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="task-goal">Goal</Label>
        <Textarea
          id="task-goal"
          rows={5}
          placeholder="What should change and why. Markdown is supported."
          value={values.goal}
          onChange={(event) => set("goal")(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="task-criteria">Acceptance criteria</Label>
        <Textarea
          id="task-criteria"
          rows={3}
          placeholder={"- [ ] Tests cover the new endpoint\n- [ ] Docs updated"}
          value={values.acceptanceCriteria}
          onChange={(event) => set("acceptanceCriteria")(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="task-scope">Scope</Label>
        <Textarea
          id="task-scope"
          rows={2}
          placeholder="Areas of the codebase this task may change"
          value={values.scope}
          onChange={(event) => set("scope")(event.target.value)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label>Base branch</Label>
          <Select value={base} onValueChange={(value) => value && set("baseBranch")(value === defaultBranch ? null : value)}>
            <SelectTrigger className="w-full font-mono text-xs" aria-label="Base branch">
              <SelectValue>{base}</SelectValue>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {(branches.length ? branches : [{ name: defaultBranch }]).map((branch) => (
                <SelectItem key={branch.name} value={branch.name} className="font-mono text-xs">
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {withBranch && (
          <div className="space-y-2">
            <Label>Existing work</Label>
            <Select
              value={values.fromBranch ?? NONE}
              onValueChange={(value) => set("fromBranch")(!value || value === NONE ? null : value)}
            >
              <SelectTrigger className="w-full font-mono text-xs" aria-label="Branch with existing work">
                <SelectValue>{values.fromBranch ?? "None: claim later"}</SelectValue>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectItem value={NONE}>None: claim later</SelectItem>
                {branches.filter((branch) => branch.name !== base).map((branch) => (
                  <SelectItem key={branch.name} value={branch.name} className="font-mono text-xs">
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="task-deps">Depends on</Label>
          <Input
            id="task-deps"
            placeholder="#12, #15"
            value={values.dependsOn}
            onChange={(event) => set("dependsOn")(event.target.value)}
          />
        </div>
      </div>
      {withBranch && values.fromBranch && (
        <p className="rounded-lg bg-info/8 px-3 py-2 text-sm text-muted-foreground">
          The current tip of <span className="font-mono text-foreground">{values.fromBranch}</span>{" "}
          becomes your submitted result, ready for review.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={pending || !values.title.trim()}>
          {pending && <LoaderCircle className="animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
