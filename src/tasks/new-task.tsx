import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { api, responseJson } from "@/lib/api";
import { Panel } from "@/code/repo-shared";
import type { RepoLinks } from "@/code/repo-shared";
import { TaskForm, type TaskFormValues } from "./task-form";
import { taskKeys } from "./tasks-api";

export function NewTaskView({
  repo,
  links,
}: {
  repo: string;
  links: RepoLinks;
  defaultBranch: string;
}) {
  const [searchParams] = useSearchParams();
  const branch = searchParams.get("branch");
  const navigate = useNavigate();
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: async (json: TaskFormValues & { fromBranch: string | null }) => responseJson(
      await api.api.code.repos[":name"].tasks.$post({ param: { name: repo }, json }),
    ),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: taskKeys.list(repo) });
      navigate(links.task(result.task.number));
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h2 className="text-lg font-semibold">New task</h2>
        <p className="text-sm text-muted-foreground">
          Describe the outcome. Someone claims it, works on a dedicated branch, and submits a
          result that is reviewed and fast-forwarded into the base branch.
        </p>
      </div>
      <Panel className="p-5">
        <TaskForm
          repo={repo}
          withBranch
          initialBranch={branch}
          initial={branch ? { title: branch.split("/").at(-1)?.replace(/[-_]/gu, " ") ?? "" } : undefined}
          submitLabel="Create task"
          pending={create.isPending}
          onSubmit={(values) => create.mutate(values)}
          onCancel={() => navigate(links.tasks())}
        />
      </Panel>
    </div>
  );
}
