import { Search, UserPlus, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { avatarSrc } from "../../shared/avatar";
import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Button } from "../components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "../components/ui/combobox";
import { Input } from "../components/ui/input";
import { initials } from "../lib/utils";
import type { AdminUser } from "./types";

const SUGGESTIONS = 8;
const PAGE = 50;

type Person = Pick<
  AdminUser,
  "id" | "name" | "personalEmail" | "avatarId" | "status"
>;

function matches(person: Person, query: string) {
  return (
    person.name.toLocaleLowerCase().includes(query) ||
    Boolean(person.personalEmail?.toLocaleLowerCase().includes(query))
  );
}

/**
 * Picks people out of a workspace of any size: a search box suggests a few
 * matches to add, and the chosen people list is filtered and paged rather
 * than rendering everyone.
 */
export function PeoplePicker({
  label,
  users,
  value,
  onChange,
  renderMember,
  emptyText = "Nobody yet.",
}: {
  label: string;
  users: Person[];
  value: string[];
  onChange: (value: string[]) => void;
  /** Extra controls for one chosen person, such as a permission switch. */
  renderMember?: (userId: string) => ReactNode;
  emptyText?: string;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(PAGE);

  const byId = useMemo(
    () => new Map(users.map((user) => [user.id, user])),
    [users]
  );

  const chosen = useMemo(() => new Set(value), [value]);

  const needle = query.trim().toLocaleLowerCase();

  const suggestions = needle
    ? users
        .filter(
          (user) =>
            !chosen.has(user.id) &&
            user.status !== "disabled" &&
            matches(user, needle)
        )
        .slice(0, SUGGESTIONS)
    : [];

  const filterNeedle = filter.trim().toLocaleLowerCase();

  const members = value
    .map((id) => byId.get(id))
    .filter((person): person is Person => Boolean(person))
    .filter((person) => !filterNeedle || matches(person, filterNeedle));

  function add(person: Person) {
    onChange([...value, person.id]);
    setQuery("");
  }

  return (
    <div className="space-y-2.5">
      <Combobox<Person>
        items={suggestions}
        filter={null}
        value={null}
        inputValue={query}
        autoHighlight
        openOnInputClick={false}
        itemToStringLabel={(person) => person.name}
        isItemEqualToValue={(item, other) => item.id === other.id}
        onInputValueChange={(next, details) => {
          // Choosing someone clears the box rather than filling in their name.
          if (details.reason !== "item-press") setQuery(next);
        }}
        onValueChange={(person) => {
          if (person) add(person);
        }}
      >
        <div className="relative">
          <UserPlus className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2" />
          <ComboboxInput
            className="pl-9"
            placeholder="Add people by name or email"
            aria-label={`Add to ${label}`}
            autoComplete="off"
          />
        </div>
        <ComboboxContent
          aria-label={`People to add to ${label}`}
          className="px-0 py-1"
        >
          <ComboboxEmpty className="px-3 py-2">
            No one else matches.
          </ComboboxEmpty>
          <ComboboxList>
            {(person: Person) => (
              <ComboboxItem
                key={person.id}
                value={person}
                className="gap-2.5 rounded-none px-3 py-2 text-xs"
              >
                <PersonLine person={person} />
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>

      <div className="bg-surface-sunken/50 ring-border overflow-hidden rounded-xl ring-1">
        <div className="border-border/60 flex items-center gap-3 border-b px-3.5 py-2">
          <span className="text-foreground/85 text-xs font-semibold tabular-nums">
            {value.length === 1 ? "1 person" : `${value.length} people`}
          </span>
          {value.length > 8 ? (
            <div className="relative ml-auto w-48">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                className="h-7 pl-8 text-xs"
                value={filter}
                placeholder="Filter"
                aria-label={`Filter ${label}`}
                onChange={(event) => {
                  setFilter(event.target.value);
                  setShown(PAGE);
                }}
              />
            </div>
          ) : null}
        </div>
        <ul aria-label={label} className="divide-border/60 divide-y">
          {members.slice(0, shown).map((person) => (
            <li
              key={person.id}
              className="flex items-center gap-3 px-3.5 py-2.5 text-xs"
            >
              <PersonLine person={person} />
              {renderMember?.(person.id)}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${person.name}`}
                onClick={() => onChange(value.filter((id) => id !== person.id))}
              >
                <X />
              </Button>
            </li>
          ))}
          {members.length === 0 ? (
            <li className="text-muted-foreground px-3.5 py-4 text-center text-xs">
              {filterNeedle ? "No one here matches." : emptyText}
            </li>
          ) : null}
        </ul>
        {members.length > shown ? (
          <button
            type="button"
            className="border-border/60 text-muted-foreground hover:bg-accent/40 hover:text-foreground w-full border-t py-2 text-xs font-medium"
            onClick={() => setShown((current) => current + PAGE)}
          >
            Show {Math.min(PAGE, members.length - shown)} more of{" "}
            {members.length - shown}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function PersonLine({ person }: { person: Person }) {
  return (
    <>
      <Avatar className="size-7">
        <AvatarImage src={avatarSrc(person)} />
        <AvatarFallback className="text-[10px]">
          {initials(person.name)}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.8125rem] font-semibold">
          {person.name}
        </span>
        <span className="text-muted-foreground block truncate">
          {person.personalEmail}
        </span>
      </span>
    </>
  );
}
