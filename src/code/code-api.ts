import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api, responseJson } from "@/lib/api";

export const codeKeys = {
  all: ["code"] as const,
  repositories: ["code", "repositories"] as const,
  repository: (name: string) => ["code", "repository", name] as const,
  refs: (name: string) => ["code", "refs", name] as const,
  branches: (name: string) => ["code", "branches", name] as const,
  tags: (name: string) => ["code", "tags", name] as const,
  tree: (name: string, ref: string, path: string) =>
    ["code", "tree", name, ref, path] as const,
  entryCommits: (name: string, ref: string, path: string) =>
    ["code", "entry-commits", name, ref, path] as const,
  files: (name: string, ref: string) => ["code", "files", name, ref] as const,
  blob: (name: string, ref: string, path: string) =>
    ["code", "blob", name, ref, path] as const,
  commits: (name: string, ref: string, path: string) =>
    ["code", "commits", name, ref, path] as const,
  commit: (name: string, hash: string) => ["code", "commit", name, hash] as const,
  compare: (name: string, base: string, head: string, direct: boolean) =>
    ["code", "compare", name, base, head, direct] as const,
};

export const COMMITS_PAGE_SIZE = 30;

export function useRepositories() {
  return useQuery({
    queryKey: codeKeys.repositories,
    queryFn: async () => responseJson(await api.api.code.repos.$get()),
  });
}

export function useRepository(name: string) {
  return useQuery({
    queryKey: codeKeys.repository(name),
    queryFn: async () => responseJson(
      await api.api.code.repos[":name"].$get({ param: { name } }),
    ),
  });
}

export function useRefs(name: string) {
  return useQuery({
    queryKey: codeKeys.refs(name),
    queryFn: async () => responseJson(
      await api.api.code.repos[":name"].refs.$get({ param: { name } }),
    ),
    staleTime: 15_000,
  });
}

export function useBranches(name: string) {
  return useQuery({
    queryKey: codeKeys.branches(name),
    queryFn: async () => responseJson(
      await api.api.code.repos[":name"].branches.$get({ param: { name } }),
    ),
  });
}

export function useTags(name: string) {
  return useQuery({
    queryKey: codeKeys.tags(name),
    queryFn: async () => responseJson(
      await api.api.code.repos[":name"].tags.$get({ param: { name } }),
    ),
  });
}

export function useTree(name: string, ref: string, path: string) {
  return useQuery({
    queryKey: codeKeys.tree(name, ref, path),
    queryFn: async () => responseJson(
      await api.api.code.repos[":name"].tree.$get({
        param: { name },
        query: { ref, path },
      }),
    ),
    placeholderData: keepPreviousData,
  });
}

/** Last commit per directory entry; slower, so it loads after the listing. */
export function useEntryCommits(name: string, ref: string, path: string, enabled: boolean) {
  return useQuery({
    queryKey: codeKeys.entryCommits(name, ref, path),
    queryFn: async () => responseJson(
      await api.api.code.repos[":name"]["entry-commits"].$get({
        param: { name },
        query: { ref, path },
      }),
    ),
    enabled,
    staleTime: 60_000,
  });
}

export function useFileIndex(name: string, ref: string, enabled: boolean) {
  return useQuery({
    queryKey: codeKeys.files(name, ref),
    queryFn: async () => responseJson(
      await api.api.code.repos[":name"].files.$get({ param: { name }, query: { ref } }),
    ),
    enabled,
    staleTime: 60_000,
  });
}

export function useLanguages(name: string, ref: string, enabled: boolean) {
  return useQuery({
    queryKey: ["code", "languages", name, ref] as const,
    queryFn: async () => responseJson(
      await api.api.code.repos[":name"].languages.$get({ param: { name }, query: { ref } }),
    ),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useBlob(name: string, ref: string, path: string) {
  return useQuery({
    queryKey: codeKeys.blob(name, ref, path),
    queryFn: async () => responseJson(
      await api.api.code.repos[":name"].blob.$get({
        param: { name },
        query: { ref, path },
      }),
    ),
  });
}

export function useCommits(name: string, ref: string, path: string) {
  return useInfiniteQuery({
    queryKey: codeKeys.commits(name, ref, path),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => responseJson(
      await api.api.code.repos[":name"].commits.$get({
        param: { name },
        query: {
          ref,
          path,
          limit: String(COMMITS_PAGE_SIZE),
          offset: String(pageParam),
        },
      }),
    ),
    getNextPageParam: (page) => page.nextOffset ?? undefined,
  });
}

export function useCommit(name: string, hash: string) {
  return useQuery({
    queryKey: codeKeys.commit(name, hash),
    queryFn: async () => responseJson(
      await api.api.code.repos[":name"].commits[":hash"].$get({
        param: { name, hash },
      }),
    ),
    // Commits are immutable.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useCompare(
  name: string,
  base: string | null,
  head: string | null,
  direct = false,
) {
  return useQuery({
    queryKey: codeKeys.compare(name, base ?? "", head ?? "", direct),
    queryFn: async () => responseJson(
      await api.api.code.repos[":name"].compare.$get({
        param: { name },
        query: { base: base!, head: head!, ...(direct ? { direct: "1" as const } : {}) },
      }),
    ),
    enabled: Boolean(base && head),
    staleTime: 15_000,
  });
}

export function rawFileUrl(name: string, ref: string, path: string, inline = false) {
  const query = new URLSearchParams({ ref, path, ...(inline ? { inline: "1" } : {}) });
  return `/api/code/repos/${encodeURIComponent(name)}/raw?${query}`;
}
