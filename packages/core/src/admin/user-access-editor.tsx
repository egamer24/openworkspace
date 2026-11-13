import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  KeyRound,
  LoaderCircle,
  Save,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { toast } from "sonner";

import { avatarSrc } from "../../shared/avatar";
import type { WorkspacePermission } from "../../shared/workspace";
import { useAuth } from "../auth/auth-context";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { api, responseJson } from "../lib/api";
import { initials } from "../lib/utils";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
} from "./admin-panel";
import type {
  AdminPermission,
  AdminTeam,
  AdminUser,
  UpdateUserInput,
} from "./types";

export function UserAccessEditor({
  user,
  pending,
  accessLinkPending,
  onSubmit,
  onCreateAccessLink,
}: {
  user: AdminUser;
  pending: boolean;
  accessLinkPending: boolean;
  onSubmit: (input: UpdateUserInput) => void;
  onCreateAccessLink: () => void;
}) {
  const [name, setName] = useState(user.name);
  const [active, setActive] = useState(user.status === "active");

  function submit(event: FormEvent) {
    event.preventDefault();
    const input: UpdateUserInput = { name };

    // An invited person keeps that status until they accept.
    if (user.status !== "invited") {
      input.status = active ? "active" : "disabled";
    }

    onSubmit(input);
  }

  return (
    <form className={adminPanelClass} onSubmit={submit}>
      <AdminPanelHeader
        title={`Manage ${user.name}`}
        description={`Personal mailbox: ${user.personalEmail}`}
      >
        <Avatar className="size-10 shrink-0">
          <AvatarImage src={avatarSrc(user)} />
          <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
        </Avatar>
      </AdminPanelHeader>

      <AdminPanelBody className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor={`user-name-${user.id}`}>Name</Label>
          <Input
            id={`user-name-${user.id}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>
        {user.status !== "invited" && (
          <label className="bg-surface-sunken ring-border flex items-center justify-between gap-4 rounded-xl px-4 py-3 ring-1">
            <span>
              <span className="block text-[0.8125rem] font-semibold">
                Account access
              </span>
              <span className="text-muted-foreground block text-xs">
                Disabling signs them out on every device and revokes their OIDC
                tokens.
              </span>
            </span>
            <Switch checked={active} onCheckedChange={setActive} />
          </label>
        )}
      </AdminPanelBody>

      <AdminPanelFooter className="justify-between">
        <Button
          type="button"
          variant="outline"
          disabled={accessLinkPending || user.status === "disabled"}
          onClick={onCreateAccessLink}
        >
          {accessLinkPending ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <KeyRound />
          )}
          {user.status === "invited"
            ? "New invitation link"
            : user.status === "disabled"
              ? "Enable account for recovery"
              : "Recovery link"}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" /> : <Save />}
          Save changes
        </Button>
      </AdminPanelFooter>
    </form>
  );
}

/**
 * What a person may manage. Administrators manage everything; members may be
 * given parts of the workspace. Only administrators change it.
 */
export function UserPermissionsEditor({
  user,
  availablePermissions,
}: {
  user: AdminUser;
  /** Core's permissions and the installed modules'. */
  availablePermissions: AdminPermission[];
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [role, setRole] = useState(user.role);

  const [permissions, setPermissions] = useState<WorkspacePermission[]>(
    user.permissions
  );

  const editable = auth.user?.role === "admin" && auth.user.id !== user.id;

  const changed =
    role !== user.role ||
    permissions.length !== user.permissions.length ||
    permissions.some((permission) => !user.permissions.includes(permission));

  const save = useMutation({
    mutationFn: async () =>
      responseJson(
        await api.api.admin.users[":id"].$patch({
          param: { id: user.id },
          json: { role, permissions: role === "admin" ? [] : permissions },
        })
      ),
    onSuccess: async () => {
      toast.success("Permissions updated");
      await queryClient.invalidateQueries({ queryKey: ["admin-state"] });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={ShieldCheck}
        title="Permissions"
        description={
          role === "admin"
            ? "Administrators manage everything in the workspace."
            : "Members use their mail and apps. Give them parts of the workspace to manage here."
        }
      />
      <AdminPanelBody className="space-y-5">
        <label className="bg-surface-sunken ring-border flex items-center justify-between gap-4 rounded-xl px-4 py-3 ring-1 has-disabled:opacity-70">
          <span>
            <span className="block text-[0.8125rem] font-semibold">
              Administrator
            </span>
            <span className="text-muted-foreground block text-xs">
              Workspace settings, mail domains, and everything below.
            </span>
          </span>
          <Switch
            checked={role === "admin"}
            disabled={!editable}
            onCheckedChange={(checked) => setRole(checked ? "admin" : "member")}
          />
        </label>
        {role === "member" ? (
          <div className="divide-border/60 bg-surface-sunken/50 ring-border divide-y overflow-hidden rounded-xl ring-1">
            {availablePermissions.map(
              ({ id: permission, label, description }) => (
                <label
                  key={permission}
                  className="hover:bg-accent/40 flex items-start gap-3 px-3.5 py-2.5 transition-colors has-disabled:opacity-70"
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={permissions.includes(permission)}
                    disabled={!editable}
                    onCheckedChange={(checked) =>
                      setPermissions(
                        checked
                          ? [...permissions, permission]
                          : permissions.filter((value) => value !== permission)
                      )
                    }
                  />
                  <span className="min-w-0">
                    <span className="block text-[0.8125rem] font-medium">
                      {label}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {description}
                    </span>
                  </span>
                </label>
              )
            )}
          </div>
        ) : null}
      </AdminPanelBody>
      {editable ? (
        <AdminPanelFooter>
          <Button
            type="button"
            disabled={!changed || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Save />
            )}
            Save permissions
          </Button>
        </AdminPanelFooter>
      ) : null}
    </div>
  );
}

/**
 * The teams a person is on, which decide their team mailboxes and the apps
 * they may sign in to. Everyone includes every active person and is not
 * listed. Changeable by anyone who manages teams.
 */
export function UserTeamsEditor({
  user,
  teams,
}: {
  user: AdminUser;
  teams: AdminTeam[];
}) {
  const auth = useAuth();
  const queryClient = useQueryClient();

  const editable =
    auth.user?.role === "admin" ||
    Boolean(auth.user?.permissions.includes("manage_teams"));

  const listed = teams
    .filter((team) => !team.everyone)
    .sort((a, b) => a.name.localeCompare(b.name));

  const saved = listed
    .filter((team) => team.members.some((member) => member.userId === user.id))
    .map((team) => team.id);

  const [teamIds, setTeamIds] = useState(saved);

  const changed =
    teamIds.length !== saved.length ||
    teamIds.some((id) => !saved.includes(id));

  const save = useMutation({
    mutationFn: async () =>
      responseJson(
        await api.api.admin.teams.person[":userId"].$put({
          param: { userId: user.id },
          json: { teamIds },
        })
      ),
    onSuccess: async () => {
      toast.success("Teams updated");
      await queryClient.invalidateQueries({ queryKey: ["admin-state"] });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={UsersRound}
        title="Teams"
        description={`Teams give access to their mailboxes and to single sign-on apps. ${
          user.status === "active"
            ? "Everyone includes this person automatically."
            : "Everyone includes active people only."
        }`}
      />
      <AdminPanelBody>
        {listed.length ? (
          <div className="divide-border/60 bg-surface-sunken/50 ring-border divide-y overflow-hidden rounded-xl ring-1">
            {listed.map((team) => (
              <label
                key={team.id}
                className="hover:bg-accent/40 flex items-center gap-3 px-3.5 py-2.5 transition-colors has-disabled:opacity-70"
              >
                <Checkbox
                  checked={teamIds.includes(team.id)}
                  disabled={!editable}
                  onCheckedChange={(checked) =>
                    setTeamIds(
                      checked
                        ? [...teamIds, team.id]
                        : teamIds.filter((id) => id !== team.id)
                    )
                  }
                />
                <span className="min-w-0">
                  <span className="block truncate text-[0.8125rem] font-medium">
                    {team.name}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {team.slug}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            No teams yet besides Everyone.
          </p>
        )}
      </AdminPanelBody>
      {editable && listed.length ? (
        <AdminPanelFooter>
          <Button
            type="button"
            disabled={!changed || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Save />
            )}
            Save teams
          </Button>
        </AdminPanelFooter>
      ) : null}
    </div>
  );
}
