import { KeyRound, Palette, Plug, ShieldCheck, UserRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Fragment } from "react";
import { NavLink, Outlet, useLocation } from "react-router";

import { required } from "../../shared/invariant";
import {
  SectionGroupLabel,
  SectionShell,
  sectionItemClass,
} from "../components/section-shell";
import { clientModules } from "../modules";

type SettingsSection = {
  id: string;
  label: string;
  description: string;
  Icon: LucideIcon;
};

const coreSections: SettingsSection[] = [
  {
    id: "profile",
    label: "Profile",
    description: "Your photo and account details.",
    Icon: UserRound,
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Light, dark, or match the system.",
    Icon: Palette,
  },
  {
    id: "sessions",
    label: "Sessions",
    description: "Active sign-ins and locations.",
    Icon: ShieldCheck,
  },
  {
    id: "mcp",
    label: "MCP",
    description: "Connect an AI agent or editor to your workspace.",
    Icon: KeyRound,
  },
  {
    id: "connected-apps",
    label: "Connected apps",
    description: "Apps you allowed to use your account, and what each may do.",
    Icon: Plug,
  },
];

/** Core's sections under "Account", then each module's under its app's name. */
function settingsGroups(): {
  label: string;
  sections: SettingsSection[];
}[] {
  return [
    { label: "Account", sections: coreSections },
    ...clientModules().flatMap((module) =>
      module.settings?.length
        ? [
            {
              label: module.app?.label ?? module.name,
              sections: module.settings,
            },
          ]
        : []
    ),
  ];
}

function settingsSections(): SettingsSection[] {
  return settingsGroups().flatMap((group) => group.sections);
}

function sectionFromPath(pathname: string): SettingsSection {
  const sections = settingsSections();
  const id = pathname.split("/")[2];

  return (
    sections.find((section) => section.id === id) ??
    required(sections[0], "Settings have no sections")
  );
}

function SettingsNavigation({
  value,
  onNavigate,
}: {
  value: string;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Settings" className="flex flex-col gap-0.5 p-3">
      {settingsGroups().map((group, index) => (
        <Fragment key={group.label}>
          <SectionGroupLabel first={index === 0}>
            {group.label}
          </SectionGroupLabel>
          {group.sections.map(({ id, label, Icon }) => (
            <NavLink
              key={id}
              to={`/settings/${id}`}
              onClick={onNavigate}
              className={sectionItemClass(value === id)}
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

export function SettingsShell() {
  const location = useLocation();
  const section = sectionFromPath(location.pathname);

  return (
    <SectionShell
      area="Settings"
      className="max-w-3xl"
      title={section.label}
      description={section.description}
      renderNavigation={(onNavigate) => (
        <SettingsNavigation value={section.id} onNavigate={onNavigate} />
      )}
    >
      <Outlet />
    </SectionShell>
  );
}
