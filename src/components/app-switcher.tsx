import { GitBranch, Mail, type LucideIcon } from "lucide-react";
import { NavLink, useLocation } from "react-router";
import { cn } from "@/lib/utils";

type AppSection = "mail" | "git";

const sections: Array<{ id: AppSection; label: string; to: string; Icon: LucideIcon }> = [
  { id: "mail", label: "Mail", to: "/", Icon: Mail },
  { id: "git", label: "Git", to: "/git", Icon: GitBranch },
];

export function appSectionFromPath(pathname: string): AppSection {
  if (pathname.startsWith("/git")) return "git";
  return "mail";
}

/** Top-level switch between workspace apps, shown in every app header. */
export function AppSwitcher({ className }: { className?: string }) {
  const active = appSectionFromPath(useLocation().pathname);
  return (
    <nav
      aria-label="Workspace apps"
      className={cn(
        "inline-flex h-9 items-center rounded-xl bg-surface-sunken p-1 ring-1 ring-border",
        className,
      )}
    >
      {sections.map(({ id, label, to, Icon }) => (
        <NavLink
          key={id}
          to={to}
          aria-current={active === id ? "page" : undefined}
          className={cn(
            "inline-flex h-full items-center gap-1.5 rounded-lg px-2.5 text-[0.8125rem] font-medium transition-colors",
            active === id
              ? "bg-surface text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-4" />
          <span className="hidden sm:inline">{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
