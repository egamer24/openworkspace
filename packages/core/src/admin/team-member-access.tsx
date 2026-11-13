import { Switch } from "../components/ui/switch";
import { PeoplePicker } from "./people-picker";
import type { AdminTeamMember, AdminUser } from "./types";

/** Who is on a team, and whether each member may send from the team's inboxes. */
export function TeamMemberAccess({
  users,
  value,
  onChange,
}: {
  users: AdminUser[];
  value: AdminTeamMember[];
  onChange: (value: AdminTeamMember[]) => void;
}) {
  const canSend = new Map(
    value.map((member) => [member.userId, member.canSend])
  );

  return (
    <PeoplePicker
      label="Team members"
      users={users}
      value={value.map((member) => member.userId)}
      onChange={(ids) =>
        onChange(
          ids.map((userId) => ({
            userId,
            canSend: canSend.get(userId) ?? true,
          }))
        )
      }
      emptyText="No members yet. Search above to add people."
      renderMember={(userId) => (
        <label className="text-muted-foreground flex shrink-0 items-center gap-2.5">
          <span className="hidden sm:inline">
            {canSend.get(userId) ? "Read & send" : "Read only"}
          </span>
          <Switch
            size="sm"
            aria-label="Can send from team inboxes"
            checked={canSend.get(userId) ?? true}
            onCheckedChange={(checked) =>
              onChange(
                value.map((member) =>
                  member.userId === userId
                    ? { ...member, canSend: checked }
                    : member
                )
              )
            }
          />
        </label>
      )}
    />
  );
}
