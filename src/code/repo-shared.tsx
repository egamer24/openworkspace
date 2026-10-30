import { formatDistanceToNow } from "date-fns";
import { Check, Copy, LoaderCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function encodePath(path: string) {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/** URL builders for one repository; `ref` sticks while browsing. */
export function repoLinks(repo: string, ref: string, defaultRef: string) {
  const query = ref === defaultRef ? "" : `?ref=${encodeURIComponent(ref)}`;
  const at = (target: string) => `?ref=${encodeURIComponent(target)}`;
  return {
    home: () => `/git/${repo}`,
    tree: (path: string, target?: string) =>
      `/git/${repo}${path || target ? `/tree/${encodePath(path)}` : ""}${target ? at(target) : query}`,
    blob: (path: string, target?: string) =>
      `/git/${repo}/blob/${encodePath(path)}${target ? at(target) : query}`,
    commits: (path = "") => `/git/${repo}/commits${path ? `/${encodePath(path)}` : ""}${query}`,
    commit: (hash: string) => `/git/${repo}/commit/${hash}`,
    branches: () => `/git/${repo}/branches`,
    tags: () => `/git/${repo}/tags`,
    compare: (base?: string, head?: string) =>
      `/git/${repo}/compare${base && head ? `/${encodeURIComponent(base)}...${encodeURIComponent(head)}` : ""}`,
    settings: () => `/git/${repo}/settings`,
    tasks: () => `/git/${repo}/tasks`,
    task: (number: number, tab = "") => `/git/${repo}/tasks/${number}${tab ? `/${tab}` : ""}`,
    newTask: (branch?: string) =>
      `/git/${repo}/tasks/new${branch ? `?branch=${encodeURIComponent(branch)}` : ""}`,
  };
}

export type RepoLinks = ReturnType<typeof repoLinks>;

export function firstLine(message: string) {
  return message.split("\n", 1)[0] ?? "";
}

export function relative(date: string) {
  return formatDistanceToNow(new Date(date), { addSuffix: true });
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function Loading({ className }: { className?: string }) {
  return (
    <div className={cn("grid min-h-40 place-items-center", className)}>
      <LoaderCircle className="animate-spin text-muted-foreground" />
    </div>
  );
}

export function ErrorText({ error }: { error: Error }) {
  return <p className="text-sm text-destructive">{error.message}</p>;
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-surface", className)}>
      {children}
    </div>
  );
}

export function PanelHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-border/70 bg-surface-sunken/60 px-4 py-2.5 text-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PersonAvatar({
  person,
  className,
}: {
  person: { name: string; avatarUrl?: string | null };
  className?: string;
}) {
  return (
    <Avatar className={cn("size-6", className)}>
      {person.avatarUrl ? <AvatarImage src={person.avatarUrl} /> : null}
      <AvatarFallback className="text-[10px]">
        {person.name.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

export async function copyText(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  } catch {
    toast.error(`${label} could not be copied`);
  }
}

/** Short SHA with a copy button, as shown next to commits. */
export function ShaButton({ hash, className }: { hash: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="xs"
      className={cn("font-mono", className)}
      onClick={async () => {
        await copyText(hash, "Commit SHA");
        setCopied(true);
        setTimeout(() => setCopied(false), 1_500);
      }}
    >
      {hash.slice(0, 7)}
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
