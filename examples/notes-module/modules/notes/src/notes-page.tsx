import { avatarSrc } from "@open-workspace/core/shared";
import {
  AppearanceMenuRow,
  AppSwitcher,
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  initials,
  Label,
  responseJson,
  Skeleton,
  useAuth,
  useConfirm,
  useWorkspaceBrand,
  WorkspaceLogo,
} from "@open-workspace/core/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LogOut,
  NotebookPen,
  Settings,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import { NOTE_BODY_MAX, NOTE_TITLE_MAX, NOTES_MODULE } from "../shared/module";
import { formatDate, notesApi, notesKeys } from "./api";

/** The workspace's logo and name, then the app switcher, as every app's header starts. */
function ProductMark() {
  const brand = useWorkspaceBrand();

  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <WorkspaceLogo src={brand.logoUrl} flat />
      <span className="flex min-w-0 items-center gap-2 text-[14px] leading-none tracking-[-0.015em]">
        <span className="hidden truncate font-semibold sm:inline">
          {brand.name}
        </span>
        <span className="bg-border hidden h-3.5 w-px shrink-0 sm:block" />
        <AppSwitcher current={NOTES_MODULE} />
      </span>
    </span>
  );
}

function AccountMenu() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { user } = auth;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account: ${user?.name ?? "signed in"}`}
        className="hover:bg-foreground/[0.05] focus-visible:ring-ring aria-expanded:bg-foreground/[0.05] flex size-9 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2"
      >
        <Avatar className="size-8">
          <AvatarImage src={avatarSrc(user)} />
          <AvatarFallback className="bg-primary/12 text-primary text-[11px] font-semibold">
            {initials(user?.name ?? "?")}
          </AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-60">
        <p className="truncate px-2 py-2 text-[13px] font-semibold">
          {user?.name}
        </p>
        <DropdownMenuSeparator />
        <AppearanceMenuRow />
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/settings/notes")}>
          <Settings />
          Settings
        </DropdownMenuItem>
        {user?.permissions.length ? (
          <DropdownMenuItem onClick={() => navigate("/admin")}>
            <ShieldCheck />
            Administration
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => void auth.logout()}
        >
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A sheet of ruled paper: the one place the app shows some character. */
const ruled =
  "bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_calc(1.75rem-1px),color-mix(in_oklch,var(--border),transparent_35%)_calc(1.75rem-1px),color-mix(in_oklch,var(--border),transparent_35%)_1.75rem)] bg-local";

function Composer() {
  const client = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const create = useMutation({
    mutationFn: async () =>
      responseJson(await notesApi.api.notes.$post({ json: { title, body } })),
    onSuccess: async () => {
      setTitle("");
      setBody("");
      await client.invalidateQueries({ queryKey: notesKeys.own });
    },
    onError: (error) => toast.error(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();

    if (title.trim()) create.mutate();
  }

  return (
    <form
      onSubmit={submit}
      aria-label="New note"
      className="border-border bg-surface overflow-hidden rounded-xl border shadow-[var(--pane-shadow)]"
    >
      <div className="border-primary/35 border-l-2 pl-4 sm:ml-10">
        <Label htmlFor="note-title" className="sr-only">
          Title
        </Label>
        <input
          id="note-title"
          value={title}
          maxLength={NOTE_TITLE_MAX}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Title"
          className="placeholder:text-muted-foreground/70 h-12 w-full bg-transparent pr-4 text-[17px] font-semibold tracking-[-0.01em] outline-none"
        />
        <Label htmlFor="note-body" className="sr-only">
          Note
        </Label>
        <textarea
          id="note-body"
          value={body}
          maxLength={NOTE_BODY_MAX}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              submit(event);
            }
          }}
          placeholder="Write something down…"
          rows={4}
          className={cn(
            "placeholder:text-muted-foreground/70 block w-full resize-none bg-transparent pr-4 pb-2 text-[14px] leading-7 outline-none",
            ruled
          )}
        />
      </div>
      <div className="border-border/70 bg-surface-sunken/60 flex items-center justify-between gap-3 border-t px-4 py-2.5">
        <p className="text-muted-foreground hidden text-xs sm:block">
          Ctrl or ⌘ + Enter adds it
        </p>
        <Button
          type="submit"
          size="sm"
          className="ml-auto"
          disabled={!title.trim() || create.isPending}
        >
          Add note
        </Button>
      </div>
    </form>
  );
}

function NoteList() {
  const client = useQueryClient();
  const { confirm, dialog } = useConfirm();

  const list = useQuery({
    queryKey: notesKeys.own,
    queryFn: async () => responseJson(await notesApi.api.notes.$get()),
  });

  const remove = useMutation({
    mutationFn: async (id: string) =>
      responseJson(await notesApi.api.notes[":id"].$delete({ param: { id } })),
    onSuccess: () => client.invalidateQueries({ queryKey: notesKeys.own }),
    onError: (error) => toast.error(error.message),
  });

  async function deleteNote(note: { id: string; title: string }) {
    const confirmed = await confirm({
      title: `Delete “${note.title}”?`,
      description: "The note is gone for good.",
      action: "Delete note",
      destructive: true,
    });

    if (confirmed) remove.mutate(note.id);
  }

  if (list.isPending) {
    return (
      <div className="space-y-3" aria-label="Loading notes">
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  }

  if (list.isError) {
    return <p className="text-destructive text-sm">{list.error.message}</p>;
  }

  const { notes, order } = list.data;

  return (
    <section aria-labelledby="notes-heading">
      <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
        <h2 id="notes-heading" className="text-sm font-semibold">
          {notes.length === 1 ? "1 note" : `${notes.length} notes`}
        </h2>
        <Link
          to="/settings/notes"
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
        >
          {order === "title" ? "By title" : "Newest first"}
        </Link>
      </div>
      {notes.length === 0 ? (
        <div className="border-border rounded-xl border border-dashed px-6 py-12 text-center">
          <NotebookPen className="text-muted-foreground mx-auto mb-3 size-5" />
          <p className="text-sm font-medium">Nothing written yet</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Your notes are yours alone; apps you connect over MCP can read them
            too.
          </p>
        </div>
      ) : (
        <ul className="divide-border/70 border-border bg-surface divide-y overflow-hidden rounded-xl border">
          {notes.map((note) => (
            <li
              key={note.id}
              className="group flex items-start gap-3 px-4 py-3.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-semibold">
                  {note.title}
                </p>
                {note.body ? (
                  <p className="text-muted-foreground mt-0.5 line-clamp-2 text-[13px] leading-5 whitespace-pre-line">
                    {note.body}
                  </p>
                ) : null}
                <p className="text-muted-foreground/80 mt-1.5 text-[11px]">
                  {formatDate(note.createdAt)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete ${note.title}`}
                className="text-muted-foreground hover:text-destructive opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                onClick={() => void deleteNote(note)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {dialog}
    </section>
  );
}

/** The app's screen, at /notes: write a note, then the ones you wrote. */
export function NotesPage() {
  return (
    <div className="bg-background min-h-dvh">
      <header className="flex h-12 items-center justify-between gap-3 px-3 lg:px-4">
        <ProductMark />
        <AccountMenu />
      </header>
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 pt-6 pb-16 sm:pt-10">
        <Composer />
        <NoteList />
      </main>
    </div>
  );
}
