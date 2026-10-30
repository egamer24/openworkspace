import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { TaskDetail, TaskStatus } from "../../shared/tasks";
import { api, responseJson } from "@/lib/api";

export const taskKeys = {
  all: ["tasks"] as const,
  list: (repo: string) => ["tasks", "list", repo] as const,
  detail: (repo: string, number: number) => ["tasks", "detail", repo, number] as const,
  mergeability: (repo: string, number: number) =>
    ["tasks", "mergeability", repo, number] as const,
  people: ["tasks", "people"] as const,
};

export const statusLabels: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  in_review: "In review",
  merged: "Merged",
  closed: "Closed",
};

export const statusVariant: Record<
  TaskStatus,
  "outline" | "info" | "warning" | "success" | "secondary" | "default"
> = {
  open: "outline",
  in_progress: "info",
  in_review: "warning",
  merged: "default",
  closed: "secondary",
};

export function useTasks(repo: string) {
  return useQuery({
    queryKey: taskKeys.list(repo),
    queryFn: async () => responseJson(
      await api.api.code.repos[":name"].tasks.$get({ param: { name: repo } }),
    ),
    refetchInterval: 30_000,
  });
}

export function useTask(repo: string, number: number) {
  return useQuery({
    queryKey: taskKeys.detail(repo, number),
    queryFn: async () => responseJson(
      await api.api.code.repos[":name"].tasks[":number"].$get({
        param: { name: repo, number: String(number) },
      }),
    ),
    refetchInterval: 30_000,
  });
}

export function useMergeability(repo: string, number: number, enabled: boolean) {
  return useQuery({
    queryKey: taskKeys.mergeability(repo, number),
    queryFn: async () => responseJson(
      await api.api.code.repos[":name"].tasks[":number"].mergeability.$get({
        param: { name: repo, number: String(number) },
      }),
    ),
    enabled,
    refetchInterval: 30_000,
  });
}

export function usePeople(repo: string) {
  return useQuery({
    queryKey: taskKeys.people,
    queryFn: async () => responseJson(
      await api.api.code.repos[":name"].tasks.people.$get({ param: { name: repo } }),
    ),
    staleTime: 5 * 60_000,
  });
}

/** Runs a task mutation and stores the returned task detail in the cache. */
export function useTaskMutation<Input>(
  repo: string,
  number: number,
  run: (input: Input) => Promise<{ task: TaskDetail }>,
  success?: string,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: async (result) => {
      client.setQueryData(taskKeys.detail(repo, number), { ok: true, task: result.task });
      await Promise.all([
        client.invalidateQueries({ queryKey: taskKeys.list(repo) }),
        client.invalidateQueries({ queryKey: taskKeys.mergeability(repo, number) }),
      ]);
      if (success) toast.success(success);
    },
    onError: (error) => toast.error(error.message),
  });
}
