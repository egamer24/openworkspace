import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Plus, Save, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import {
  branchPushPolicies,
  type BranchProtectionRule,
  type BranchPushPolicy,
} from "../../shared/code";
import { useAuth } from "@/auth/auth-context";
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { codeKeys } from "./code-api";
import { Panel, PanelHeader } from "./repo-shared";

const policyLabels: Record<BranchPushPolicy, string> = {
  members: "Members push",
  admins: "Admins push",
  integration: "Merge via tasks only",
};

function Section({ title, description, children }: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Panel>
      <PanelHeader className="block">
        <h3 className="font-semibold">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </PanelHeader>
      <div className="space-y-4 p-4">{children}</div>
    </Panel>
  );
}

export function SettingsView({
  repo,
  description,
  rules,
}: {
  repo: string;
  description: string | null;
  rules: BranchProtectionRule[];
}) {
  const auth = useAuth();
  const admin = auth.user?.role === "admin";
  const client = useQueryClient();
  const navigate = useNavigate();
  const [about, setAbout] = useState(description ?? "");
  const [draft, setDraft] = useState<BranchProtectionRule[]>(rules);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmName, setConfirmName] = useState("");

  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: codeKeys.repository(repo) }),
    client.invalidateQueries({ queryKey: codeKeys.repositories }),
  ]);
  const saveAbout = useMutation({
    mutationFn: async () => responseJson(
      await api.api.code.repos[":name"].$patch({ param: { name: repo }, json: { description: about } }),
    ),
    onSuccess: async () => {
      await refresh();
      toast.success("Description saved");
    },
    onError: (error) => toast.error(error.message),
  });
  const saveRules = useMutation({
    mutationFn: async () => responseJson(
      await api.api.code.repos[":name"]["branch-protections"].$put({
        param: { name: repo },
        json: { rules: draft.filter((rule) => rule.pattern.trim()) },
      }),
    ),
    onSuccess: async () => {
      await refresh();
      await client.invalidateQueries({ queryKey: codeKeys.branches(repo) });
      toast.success("Branch protection saved");
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: async () => responseJson(
      await api.api.code.repos[":name"].$delete({ param: { name: repo } }),
    ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: codeKeys.all });
      toast.success(`${repo} deleted`);
      navigate("/git");
    },
    onError: (error) => toast.error(error.message),
  });

  const update = (index: number, patch: Partial<BranchProtectionRule>) =>
    setDraft((current) => current.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)));

  return (
    <div className="max-w-3xl space-y-5">
      {!admin && (
        <p className="rounded-lg border border-border bg-surface-sunken/60 px-3 py-2 text-sm text-muted-foreground">
          Only administrators can change repository settings.
        </p>
      )}
      <Section title="About" description="Shown in the repository list and header.">
        <Textarea rows={2} value={about} disabled={!admin} onChange={(event) => setAbout(event.target.value)} />
        {admin && (
          <Button size="sm" disabled={saveAbout.isPending || about === (description ?? "")} onClick={() => saveAbout.mutate()}>
            {saveAbout.isPending ? <LoaderCircle className="animate-spin" /> : <Save />} Save
          </Button>
        )}
      </Section>

      <Section
        title="Branch protection"
        description="Checked by the Git proxy before a push is accepted. Use * within a path segment and ** across segments. Merging a task into a protected branch requires an approval."
      >
        {draft.length === 0 && <p className="text-sm text-muted-foreground">No protected branches.</p>}
        <ul className="space-y-3">
          {draft.map((rule, index) => (
            <li key={index} className="grid gap-2 rounded-lg border border-border/70 p-3 sm:grid-cols-[1fr_16rem_auto] sm:items-center">
              <Input
                aria-label="Branch pattern"
                className="font-mono"
                placeholder="main or release/*"
                disabled={!admin}
                value={rule.pattern}
                onChange={(event) => update(index, { pattern: event.target.value })}
              />
              <Select
                value={rule.push}
                disabled={!admin}
                onValueChange={(value) => value && update(index, { push: value as BranchPushPolicy })}
              >
                <SelectTrigger className="w-full" aria-label="Push policy">
                  <SelectValue>{policyLabels[rule.push]}</SelectValue>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  {branchPushPolicies.map((policy) => (
                    <SelectItem key={policy} value={policy}>{policyLabels[policy]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox
                    checked={rule.allowDeletion}
                    disabled={!admin}
                    onCheckedChange={(value) => update(index, { allowDeletion: Boolean(value) })}
                  />
                  Deletable
                </label>
                {admin && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setDraft((current) => current.filter((_, at) => at !== index))}
                  >
                    <Trash2 />
                    <span className="sr-only">Remove rule</span>
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {admin && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDraft((current) => [...current, { pattern: "", push: "admins", allowDeletion: false }])}
            >
              <Plus /> Add rule
            </Button>
            <Button size="sm" disabled={saveRules.isPending} onClick={() => saveRules.mutate()}>
              {saveRules.isPending ? <LoaderCircle className="animate-spin" /> : <Save />} Save rules
            </Button>
          </div>
        )}
      </Section>

      {admin && (
        <Section title="Danger zone" description="Deleting removes Git storage, tasks, and reviews. It cannot be undone.">
          <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
            <Trash2 /> Delete repository
          </Button>
        </Section>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {repo}?</AlertDialogTitle>
            <AlertDialogDescription>
              All branches, history, and tasks are removed permanently. Type the repository name to confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="confirm-name" className="sr-only">Repository name</Label>
            <Input id="confirm-name" className="font-mono" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={confirmName !== repo || remove.isPending}
              onClick={() => remove.mutate()}
            >
              Delete forever
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
