import {
  Bot,
  DatabaseBackup,
  KeyRound,
  Palette,
  UserRound,
  UsersRound,
  Webhook,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Fragment } from "react";
import { NavLink } from "react-router";

import type { WorkspacePermission } from "../../shared/workspace";
import { useAuth } from "../auth/auth-context";
import {
  SectionGroupLabel,
  sectionItemClass,
} from "../components/section-shell";
import { clientModules } from "../modules";

/** Core's sections; modules add theirs (see `ClientModule.admin`). */
export type CoreAdminSection =
  | "people"
  | "teams"
  | "sso-applications"
  | "webhooks"
  | "connected-apps"
  | "branding"
  | "backups";

export type AdminSection = CoreAdminSection | (string & {});

type AdminSectionItem = {
  id: AdminSection;
  label: string;
  Icon: LucideIcon;
  /** Who else may open the section; without one, only administrators can. */
  permission?: WorkspacePermission;
};

/** Core's sections under "Workspace", then each module's under its app's name. */
function adminGroups(): { label: string; sections: AdminSectionItem[] }[] {
  const groups: { label: string; sections: AdminSectionItem[] }[] = [
    {
      label: "Workspace",
      sections: [
        {
          id: "people",
          label: "People",
          Icon: UserRound,
          permission: "manage_people",
        },
        {
          id: "teams",
          label: "Teams",
          Icon: UsersRound,
          permission: "manage_teams",
        },
        {
          id: "sso-applications",
          label: "Single sign-on apps",
          Icon: KeyRound,
          permission: "manage_apps",
        },
        {
          id: "webhooks",
          label: "Webhooks",
          Icon: Webhook,
          permission: "manage_webhooks",
        },
        { id: "connected-apps", label: "Connected apps", Icon: Bot },
        { id: "branding", label: "Branding", Icon: Palette },
        { id: "backups", label: "Backups", Icon: DatabaseBackup },
      ],
    },
    ...clientModules().flatMap((module) =>
      module.admin?.length
        ? [{ label: module.app?.label ?? module.name, sections: module.admin }]
        : []
    ),
  ];

  // A section's id is its URL segment, so only the first section with an id gets it.
  const seen = new Set<string>();

  return groups.map((group) => ({
    ...group,
    sections: group.sections.filter(({ id }) => {
      if (!seen.has(id)) {
        seen.add(id);

        return true;
      }

      console.error(
        `Administration section "${id}" is defined twice; the later one is left out`
      );

      return false;
    }),
  }));
}

/** The groups and sections the signed-in user may open, in navigation order. */
function useAdminGroups() {
  const { user } = useAuth();

  const allowed = ({ permission }: AdminSectionItem) =>
    user?.role === "admin" ||
    Boolean(permission && user?.permissions.includes(permission));

  return adminGroups()
    .map((group) => ({ ...group, sections: group.sections.filter(allowed) }))
    .filter((group) => group.sections.length > 0);
}

/** The admin sections the signed-in user may open, in navigation order. */
export function useAdminSections() {
  return useAdminGroups().flatMap((group) => group.sections);
}

/** Where a section, or a record in it, lives. */
export function adminPath(section: AdminSection, id?: string) {
  return `/admin/${encodeURIComponent(section)}${id ? `/${encodeURIComponent(id)}` : ""}`;
}

/** The sections as links, so each opens in a new tab too; NavLink marks the current one `aria-current`, a record in it included. */
export function AdminNavigation({
  value,
  onNavigate,
}: {
  value: AdminSection;
  onNavigate?: () => void;
}) {
  const groups = useAdminGroups();

  return (
    <nav aria-label="Administration" className="flex flex-col gap-0.5 p-3">
      {groups.map((group, index) => (
        <Fragment key={group.label}>
          <SectionGroupLabel first={index === 0}>
            {group.label}
          </SectionGroupLabel>
          {group.sections.map(({ id, label, Icon }) => (
            <NavLink
              key={id}
              to={adminPath(id)}
              onClick={onNavigate}
              className={sectionItemClass(id === value)}
            >
              <Icon />
              {label}
            </NavLink>
          ))}
        </Fragment>
      ))}
    </nav>
  );
}
