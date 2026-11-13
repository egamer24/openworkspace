import { Search, SlidersHorizontal, UserPlus, Users } from "lucide-react";
import { useState } from "react";

import { avatarSrc } from "../../shared/avatar";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { initials } from "../lib/utils";
import { AdminListEmpty, adminListClass } from "./admin-panel";
import type { AdminUser } from "./types";

const PEOPLE_PAGE = 50;

export function PeopleList({
  users,
  loading,
  onManage,
  onInvite,
}: {
  users?: AdminUser[];
  loading: boolean;
  onManage: (id: string) => void;
  onInvite: () => void;
}) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PEOPLE_PAGE);

  if (loading) return <ListSkeleton />;

  if (!users?.length) {
    return (
      <div className={adminListClass}>
        <AdminListEmpty Icon={Users} title="No people yet">
          Invite someone to create their personal mailbox.
        </AdminListEmpty>
      </div>
    );
  }

  const needle = query.trim().toLocaleLowerCase();

  const matching = needle
    ? users.filter(
        (user) =>
          user.name.toLocaleLowerCase().includes(needle) ||
          Boolean(user.personalEmail?.toLocaleLowerCase().includes(needle))
      )
    : users;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          className="bg-surface pl-9"
          value={query}
          placeholder={`Search ${users.length === 1 ? "1 person" : `${users.length} people`}`}
          aria-label="Search people"
          onChange={(event) => {
            setQuery(event.target.value);
            setShown(PEOPLE_PAGE);
          }}
        />
      </div>
      <div className={adminListClass}>
        {matching.slice(0, shown).map((user) => (
          <div
            key={user.id}
            className="hover:bg-accent/45 flex items-center gap-4 px-4 py-3.5 transition-colors"
          >
            <Avatar className="size-10">
              <AvatarImage src={avatarSrc(user)} />
              <AvatarFallback className="text-xs">
                {initials(user.name)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{user.name}</p>
              <p className="text-muted-foreground truncate text-xs">
                {user.personalEmail}
              </p>
            </div>
            <div className="hidden flex-wrap justify-end gap-1 sm:flex">
              {user.role === "admin" ? <Badge>Admin</Badge> : null}
            </div>
            <Badge
              variant={user.status === "active" ? "success" : "outline"}
              className="capitalize"
            >
              {user.status}
            </Badge>
            <Button
              aria-label={`Manage ${user.name}`}
              variant="outline"
              size="sm"
              onClick={() => onManage(user.id)}
            >
              <SlidersHorizontal />{" "}
              <span className="hidden sm:inline">Manage</span>
            </Button>
          </div>
        ))}
        {matching.length === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-center text-sm">
            No one matches “{query.trim()}”.
          </p>
        ) : null}
        {users.length === 1 && !needle ? (
          <div className="bg-surface-sunken/70 flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
            <p className="text-muted-foreground min-w-0 flex-1 text-sm text-pretty">
              It's just you so far. Invite people to give them a personal
              mailbox and a passkey sign-in.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="self-start sm:self-auto"
              onClick={onInvite}
            >
              <UserPlus /> Invite your team
            </Button>
          </div>
        ) : null}
        {matching.length > shown ? (
          <button
            type="button"
            className="text-muted-foreground hover:bg-accent/40 hover:text-foreground w-full py-3 text-sm font-medium"
            onClick={() => setShown((current) => current + PEOPLE_PAGE)}
          >
            Show {Math.min(PEOPLE_PAGE, matching.length - shown)} more of{" "}
            {matching.length - shown}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className={adminListClass}>
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-4">
          <Skeleton className="size-10 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-8 w-24 shrink-0" />
        </div>
      ))}
    </div>
  );
}
