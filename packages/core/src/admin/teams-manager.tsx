import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
  UsersRound,
} from "lucide-react";
import { useId, useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { useConfirm } from "../hooks/use-confirm";
import { api, responseJson } from "../lib/api";
import {
  AdminListEmpty,
  adminListClass,
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
} from "./admin-panel";
import { toSlug } from "./slug";
import { TeamAddresses } from "./team-addresses";
import { memberCountLabel, teamMemberCount } from "./team-delivery";
import { TeamMemberAccess } from "./team-member-access";
import type { AdminMailbox, AdminTeam, AdminUser } from "./types";

export function TeamsManager({
  teams,
  users,
  mailboxes,
  domains,
  loading = false,
  selectedId,
  onSelect,
}: {
  teams: AdminTeam[];
  users: AdminUser[];
  mailboxes: AdminMailbox[];
  /** Mail domains new addresses may use, primary first. */
  domains: readonly string[];
  loading?: boolean;
  selectedId?: string;
  onSelect: (id?: string) => void;
}) {
  const queryClient = useQueryClient();

  const selected =
    selectedId === "new"
      ? undefined
      : teams.find((team) => team.id === selectedId);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-state"] }),
      queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
    ]);
  }

  if (loading) {
    return (
      <div className="max-w-3xl space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!selectedId) {
    return (
      <div className="max-w-3xl space-y-3">
        <div className="flex items-center justify-between gap-4 px-1">
          <p className="text-muted-foreground text-xs">
            {teams.length === 1 ? "1 team" : `${teams.length} teams`}
          </p>
          <Button size="sm" onClick={() => onSelect("new")}>
            <Plus /> New team
          </Button>
        </div>
        <div className={adminListClass}>
          {teams.map((team) => {
            const teamMailboxes = mailboxes.filter(
              (mailbox) => mailbox.teamId === team.id
            );

            return (
              <button
                key={team.id}
                type="button"
                className="hover:bg-accent/45 flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors"
                onClick={() => onSelect(team.id)}
              >
                <span className="bg-primary/12 text-primary grid size-9 shrink-0 place-items-center rounded-lg">
                  <UsersRound className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {team.name}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {teamMailboxes.length
                      ? teamMailboxes
                          .map((mailbox) => mailbox.address)
                          .join(", ")
                      : team.description || "No team mailbox"}
                  </span>
                </span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {team.everyone
                    ? "Everyone"
                    : memberCountLabel(teamMemberCount(team, users))}
                </span>
                <ChevronRight className="text-muted-foreground size-4 shrink-0" />
              </button>
            );
          })}
          {teams.length === 0 ? (
            <AdminListEmpty Icon={UsersRound} title="No teams yet">
              Teams group people. Give a team an address as a shared inbox, or
              as a mailing list that reaches everyone on it.
            </AdminListEmpty>
          ) : null}
        </div>
      </div>
    );
  }

  if (selectedId !== "new" && !selected) {
    return (
      <div className={`${adminPanelClass} max-w-3xl px-6 py-12 text-center`}>
        <p className="text-muted-foreground text-sm">Team not found.</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <TeamEditor
        key={selected?.id ?? "new"}
        team={selected}
        users={users}
        mailboxes={
          selected
            ? mailboxes.filter((mailbox) => mailbox.teamId === selected.id)
            : []
        }
        domains={domains}
        onSaved={async (id) => {
          await refresh();
          onSelect(id);
        }}
        onDeleted={async () => {
          await refresh();
          onSelect();
        }}
      />
    </div>
  );
}

function TeamEditor({
  team,
  users,
  mailboxes,
  domains,
  onSaved,
  onDeleted,
}: {
  team?: AdminTeam;
  users: AdminUser[];
  mailboxes: AdminMailbox[];
  /** Mail domains new addresses may use, primary first. */
  domains: readonly string[];
  onSaved: (teamId: string) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [name, setName] = useState(team?.name ?? "");
  const [slug, setSlug] = useState(team?.slug ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [members, setMembers] = useState(team?.members ?? []);
  const [everyone, setEveryone] = useState(team?.everyone ?? false);
  const [slugEdited, setSlugEdited] = useState(Boolean(team));

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name,
        slug,
        description: description.trim() || null,
        everyone,
        members,
      };

      if (team) {
        await responseJson(
          await api.api.admin.teams[":id"].$patch({
            param: { id: team.id },
            json: payload,
          })
        );

        return { teamId: team.id };
      }

      return responseJson(await api.api.admin.teams.$post({ json: payload }));
    },
    onSuccess: async ({ teamId }) => {
      toast.success(team ? "Team updated" : "Team created");
      await onSaved(teamId);
    },
    onError: (error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (!team) return;
      await responseJson(
        await api.api.admin.teams[":id"].$delete({ param: { id: team.id } })
      );
    },
    onSuccess: async () => {
      toast.success("Team deleted");
      await onDeleted();
    },
    onError: (error) => toast.error(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  const { confirm, dialog: confirmDialog } = useConfirm();
  const deleteHintId = useId();

  return (
    <form className={adminPanelClass} onSubmit={submit}>
      <div className="border-border/70 bg-surface-sunken/60 border-b px-5 py-4">
        <p className="text-muted-foreground font-mono text-[11px] tracking-[0.06em]">
          {team ? team.id : "New team"}
        </p>
        <h2 className="mt-1.5 text-lg font-semibold tracking-[-0.02em]">
          {team?.name ?? "Create a team"}
        </h2>
      </div>
      <AdminPanelBody className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="team-name">Name</Label>
            <Input
              id="team-name"
              value={name}
              placeholder="Design"
              onChange={(event) => {
                const next = event.target.value;
                setName(next);

                if (!slugEdited) setSlug(toSlug(next));
              }}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="team-slug">Handle</Label>
            <Input
              id="team-slug"
              className="font-mono"
              value={slug}
              onChange={(event) => {
                setSlugEdited(true);
                setSlug(event.target.value.toLowerCase());
              }}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              required
            />
            <p className="text-muted-foreground text-[11px]">
              Shared with SSO apps you allow, in the groups claim.
            </p>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="team-description">Description</Label>
          <Textarea
            id="team-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this team does"
          />
        </div>

        {team ? (
          <TeamAddresses team={team} mailboxes={mailboxes} domains={domains} />
        ) : (
          <p className="text-muted-foreground text-xs">
            Create the team, then give it addresses: shared inboxes or mailing
            lists.
          </p>
        )}

        <fieldset>
          <legend className="text-foreground/85 mb-2.5 text-[0.8125rem] font-semibold">
            Members
          </legend>
          <label className="bg-surface-sunken/50 ring-border mb-3 flex items-center justify-between gap-4 rounded-xl px-3.5 py-3 ring-1">
            <span className="min-w-0">
              <span className="block text-[0.8125rem] font-semibold">
                Everyone in the workspace
              </span>
              <span className="text-muted-foreground block text-xs">
                People join when they are activated and leave when they are
                disabled. All of them can send.
              </span>
            </span>
            <Switch checked={everyone} onCheckedChange={setEveryone} />
          </label>
          {everyone ? null : (
            <TeamMemberAccess
              users={users}
              value={members}
              onChange={setMembers}
            />
          )}
        </fieldset>
      </AdminPanelBody>

      <AdminPanelFooter className={team ? "justify-between" : undefined}>
        {team && (
          <div className="flex min-w-0 items-center gap-3">
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending || mailboxes.length > 0}
              aria-describedby={mailboxes.length > 0 ? deleteHintId : undefined}
              onClick={async () => {
                const confirmed = await confirm({
                  title: `Delete ${team.name}?`,
                  description:
                    "The team is removed for everyone. Its members keep their accounts.",
                  action: "Delete team",
                  destructive: true,
                });

                if (confirmed) remove.mutate();
              }}
            >
              <Trash2 /> Delete
            </Button>
            {mailboxes.length > 0 ? (
              <p id={deleteHintId} className="text-muted-foreground text-xs">
                Delete the team's addresses first.
              </p>
            ) : null}
          </div>
        )}
        <Button type="submit" disabled={save.isPending || !name || !slug}>
          {save.isPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Save />
          )}
          {team ? "Save team" : "Create team"}
        </Button>
      </AdminPanelFooter>
      {confirmDialog}
    </form>
  );
}
