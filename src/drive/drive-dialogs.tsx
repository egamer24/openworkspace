import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Copy, Folder, Link2, LoaderCircle, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, responseJson } from "@/lib/api";

export async function listDriveItems(query: {
  view?: "files" | "trash" | "shared";
  parentId?: string;
  search?: string;
  sort?: "name" | "date" | "size";
  order?: "asc" | "desc";
}) {
  return responseJson(await api.api.drive.items.$get({ query }));
}

export type DriveListing = Awaited<ReturnType<typeof listDriveItems>>;
export type DriveEntry = DriveListing["items"][number];

const selectClass = "h-9 rounded-md border bg-transparent px-2 text-sm";

export function NameDialog({ title, initialName, submitLabel, onSubmit }: {
  title: string;
  initialName: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(initialName);
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      await onSubmit(name.trim());
    } finally {
      setPending(false);
    }
  }
  return (
    <DialogContent className="sm:max-w-md">
      <form onSubmit={(event) => void submit(event)} className="grid gap-4">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Input aria-label="Name" autoFocus value={name} maxLength={255} onChange={(event) => setName(event.target.value)} />
        <DialogFooter>
          <Button type="submit" disabled={pending || !name.trim()}>{submitLabel}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** Browse folders of the item's drive and move it into the one that is open. */
export function MoveDialog({ item, onMove }: {
  item: DriveEntry;
  onMove: (parentId: string | null) => Promise<unknown>;
}) {
  const [trail, setTrail] = useState<Array<{ id: string; name: string }>>([]);
  const current = trail.at(-1) ?? null;
  const folders = useQuery({
    queryKey: ["drive", "move", current?.id ?? "root"],
    queryFn: () => listDriveItems(current ? { parentId: current.id } : {}),
  });
  const choices = folders.data?.items.filter((entry) => entry.kind === "folder" && entry.id !== item.id) ?? [];
  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle className="truncate">Move “{item.name}”</DialogTitle>
        <DialogDescription>{current ? current.name : "My Drive"}</DialogDescription>
      </DialogHeader>
      <div className="max-h-72 min-h-32 overflow-y-auto rounded-md border">
        {current && (
          <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => setTrail(trail.slice(0, -1))}>
            <ChevronLeft className="size-4" /> Back
          </button>
        )}
        {folders.isLoading && <LoaderCircle className="m-4 size-4 animate-spin text-muted-foreground" />}
        {choices.map((entry) => (
          <button key={entry.id} type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => setTrail([...trail, { id: entry.id, name: entry.name }])}>
            <Folder className="size-4 text-muted-foreground" /> <span className="truncate">{entry.name}</span>
          </button>
        ))}
        {folders.isSuccess && !choices.length && <p className="px-3 py-2 text-sm text-muted-foreground">No folders here</p>}
      </div>
      <DialogFooter>
        <Button disabled={(current?.id ?? null) === item.parentId} onClick={() => void onMove(current?.id ?? null)}>
          Move here
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function endOfDay(date: string) {
  return date ? new Date(`${date}T23:59:59`).getTime() : null;
}

export function ShareDialog({ item }: { item: DriveEntry }) {
  const client = useQueryClient();
  const queryKey = ["drive", "shares", item.id];
  const shares = useQuery({
    queryKey,
    queryFn: async () => responseJson(await api.api.drive.items[":id"].shares.$get({ param: { id: item.id } })),
  });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [access, setAccess] = useState<"download" | "view">("download");
  const [expires, setExpires] = useState("");
  const [password, setPassword] = useState("");
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey });
  const onError = (error: Error) => toast.error(error.message);

  const share = useMutation({
    mutationFn: async (input: { email: string; role: "viewer" | "editor" }) =>
      responseJson(await api.api.drive.items[":id"].shares.$put({ param: { id: item.id }, json: input })),
    onSuccess: async () => {
      setEmail("");
      await refresh();
    },
    onError,
  });
  const unshare = useMutation({
    mutationFn: async (userId: string) =>
      responseJson(await api.api.drive.items[":id"].shares[":userId"].$delete({ param: { id: item.id, userId } })),
    onSuccess: refresh,
    onError,
  });
  const createLink = useMutation({
    mutationFn: async () => responseJson(await api.api.drive.items[":id"].links.$post({
      param: { id: item.id },
      json: { access, expiresAt: endOfDay(expires), password: password || null },
    })),
    onSuccess: async (result) => {
      setCreatedUrl(result.url);
      setPassword("");
      await refresh();
    },
    onError,
  });
  const revoke = useMutation({
    mutationFn: async (id: string) => responseJson(await api.api.drive.links[":id"].$delete({ param: { id } })),
    onSuccess: refresh,
    onError,
  });

  return (
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle className="truncate">Share “{item.name}”</DialogTitle>
        <DialogDescription>People get access to this item{item.kind === "folder" ? " and everything inside it" : ""}.</DialogDescription>
      </DialogHeader>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          share.mutate({ email: email.trim(), role });
        }}
      >
        <Input aria-label="Email address" type="email" placeholder="name@example.com" className="min-w-0 flex-1" value={email} onChange={(event) => setEmail(event.target.value)} />
        <select aria-label="Role" className={selectClass} value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
        </select>
        <Button type="submit" disabled={!email.trim() || share.isPending}>Share</Button>
      </form>
      <ul className="divide-y rounded-md border empty:hidden">
        {shares.data?.shares.map((entry) => (
          <li key={entry.userId} className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{entry.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{entry.email}</span>
            </span>
            {entry.email && (
              <select
                aria-label={`Role for ${entry.name}`}
                className={selectClass}
                value={entry.role}
                onChange={(event) => share.mutate({ email: entry.email!, role: event.target.value as typeof role })}
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
            )}
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${entry.name}`} onClick={() => unshare.mutate(entry.userId)}>
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>

      {item.kind === "file" && (
        <div className="grid gap-3 border-t pt-4">
          <p className="flex items-center gap-2 text-sm font-medium"><Link2 className="size-4" /> Public links</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="drive-link-access">Access</Label>
              <select id="drive-link-access" className={selectClass} value={access} onChange={(event) => setAccess(event.target.value as typeof access)}>
                <option value="download">Download</option>
                <option value="view">View in browser</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="drive-link-expiry">Expires</Label>
              <Input id="drive-link-expiry" type="date" value={expires} onChange={(event) => setExpires(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="drive-link-password">Password</Label>
              <Input id="drive-link-password" type="password" autoComplete="new-password" placeholder="Optional" value={password} onChange={(event) => setPassword(event.target.value)} />
            </div>
          </div>
          <Button variant="outline" disabled={createLink.isPending || (password.length > 0 && password.length < 4)} onClick={() => createLink.mutate()}>
            Create link
          </Button>
          {createdUrl && (
            <div className="flex items-center gap-2 rounded-md border bg-surface-sunken p-2">
              <code className="min-w-0 flex-1 truncate text-xs">{createdUrl}</code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void navigator.clipboard.writeText(createdUrl).then(() => toast.success("Link copied"))}
              >
                <Copy /> Copy
              </Button>
            </div>
          )}
          <ul className="divide-y rounded-md border empty:hidden">
            {shares.data?.links.map((link) => (
              <li key={link.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                <Badge variant="outline">{link.access === "view" ? "View" : "Download"}</Badge>
                {link.hasPassword && <Badge variant="outline">Password</Badge>}
                <span className="text-muted-foreground">
                  {link.expiresAt ? `Expires ${new Date(link.expiresAt).toLocaleDateString()}` : "No expiry"}
                  {` · ${link.accessCount} ${link.accessCount === 1 ? "access" : "accesses"}`}
                </span>
                <Button className="ml-auto" size="sm" variant="ghost" onClick={() => revoke.mutate(link.id)}>Revoke</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </DialogContent>
  );
}
